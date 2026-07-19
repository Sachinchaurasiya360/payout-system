# User Payout Management System — LLD

Node.js + Express + Prisma + PostgreSQL.

This is the low-level design I followed while building the payout system. I kept
the focus on the parts where bugs can easily happen: money storage, duplicate
payouts, reconciliation, withdrawals, and failed payout recovery.

The worked example from the brief, where the final payout becomes **₹68**, is
reproduced by `src/demo.js`.

---

## 1. Problem, restated

Affiliate sales start as `pending`. Later an admin marks them as `approved` or
`rejected`.

The main rules:

1. **Advance payout** — while a sale is still pending, the user can get 10% of
   the earning as an advance. Once that advance is paid, the same sale should not
   get another advance, even if the job runs again or two jobs run at once.
2. **Final payout** — when the sale is reconciled:
   - **Approved** → credit `earning - advanceAlreadyPaid`.
   - **Rejected** → debit `advanceAlreadyPaid`, because that advance was not
     actually earned.
3. **Withdrawal restriction** — only one withdrawal is allowed in 24 hours.
4. **Failed payout recovery** — if a withdrawal payout fails, the money should go
   back to the user's balance so they can try again.

---

## 2. Core model decisions

### 2.1 Money is stored as integer *paise*

Every money column is an `Int` in paise. I did not use floating point for money.
The API still accepts/returns rupees, but the conversion happens at the edge in
`src/domain/money.js`.

Advance amount is `floor(10% of earning)` in paise. For ₹40, that becomes ₹4.
For fractional values, flooring keeps it from paying extra by accident.

### 2.2 Two distinct money concepts

| Concept | What it is | Where it lives |
|---|---|---|
| **Advance payout** | Money pushed *directly* to the user for a pending sale (10%). | A `Payout` row of type `ADVANCE`, one per sale. **Does not** touch withdrawable balance. |
| **Withdrawable balance** | What the user may withdraw, built up at reconciliation. | Cached on `User.withdrawableBalance`; every change is an append-only `BalanceTransaction`. |

This split matters a lot. An advance is already sent to the user, so I did not
add it to withdrawable balance. The withdrawable balance changes only when the
sale is reconciled, after subtracting or clawing back the advance:

```
APPROVED : balance += (earning − advancePaid)     // remaining 90% (or 100% if no advance)
REJECTED : balance −= advancePaid                 // claw back the un-earned advance
```

Worked example (3 sales @ ₹40, all advanced ₹4):

| Sale | Outcome | earning | advance | balance adjustment |
|---|---|---:|---:|---:|
| 1 | rejected | 40 | 4 | **−4** |
| 2 | approved | 40 | 4 | **+36** |
| 3 | approved | 40 | 4 | **+36** |
| | | | **Total** | **₹68** |

### 2.3 Balance is cached, ledger is the history

`User.withdrawableBalance` is there for fast reads. The ledger table
`BalanceTransaction` keeps the history of every change. Both are written in the
same DB transaction, otherwise it would be easy for the balance and history to
go out of sync.

---

## 3. Database schema

Full schema is in [`prisma/schema.prisma`](../prisma/schema.prisma). Short view:

```
User 1───∞ Sale            (a user has many sales)
Brand 1───∞ Sale           (a sale belongs to a brand)
User 1───∞ Payout          (advance + withdrawal payouts)
Sale 1───1 Payout          (a sale has at most ONE advance payout; unique saleId)
User 1───∞ BalanceTransaction
Sale/Payout ──∞ BalanceTransaction  (optional provenance links)
```

### Tables

**users**
| column | type | notes |
|---|---|---|
| id | cuid PK | |
| handle | text UNIQUE | human id, e.g. `john_doe` |
| withdrawableBalance | int | cached paise total (may be negative — see §6) |
| createdAt / updatedAt | timestamptz | |

**brands**: `id`, `code` UNIQUE (`brand_1`…), `name`.

**sales**
| column | type | notes |
|---|---|---|
| id | cuid PK | |
| userId → users.id | fk | |
| brandId → brands.id | fk | |
| status | enum `PENDING\|APPROVED\|REJECTED` | default `PENDING` |
| earning | int | gross paise |
| advancePaidAmount | int | set when advance succeeds |
| advancePaidAt | timestamptz? | **idempotency guard** — null ⇒ not yet advanced |
| reconciledAt | timestamptz? | non-null ⇒ cannot re-reconcile |

Indexes: `(userId, status)`, `(userId, advancePaidAt)` for the job scan.

**payouts**
| column | type | notes |
|---|---|---|
| id | cuid PK | |
| userId → users.id | fk | |
| type | enum `ADVANCE\|WITHDRAWAL` | |
| status | enum `PENDING\|PROCESSING\|COMPLETED\|FAILED\|CANCELLED\|REJECTED` | |
| amount | int | positive paise |
| saleId → sales.id | fk **UNIQUE**, nullable | set for `ADVANCE` only ⇒ **≤ 1 advance per sale** |
| idempotencyKey | text UNIQUE, nullable | for safe withdrawal retries |
| providerRef | text? | gateway reference |
| failureReason | text? | |
| completedAt | timestamptz? | |

Index: `(userId, type, status, createdAt)` for the 24h window lookup.

Why `saleId` is unique and nullable: advance payouts have a `saleId`, so the DB
can block duplicate advances for the same sale. Withdrawal payouts do not have a
saleId, and Postgres allows many `NULL` values in a unique column.

**balance_transactions** (append-only)
| column | type | notes |
|---|---|---|
| id | cuid PK | |
| userId → users.id | fk | |
| type | enum `RECONCILIATION_CREDIT\|RECONCILIATION_CLAWBACK\|WITHDRAWAL_DEBIT\|WITHDRAWAL_REVERSAL` | |
| amount | int | **signed** delta |
| balanceAfter | int | balance immediately after this entry |
| saleId / payoutId | fk? | provenance |
| reason | text? | |

---

## 4. Module design

I kept the app split into routes, services, domain helpers, and DB access.
Routes handle HTTP. Services hold the business rules. Domain files keep small
pure logic like money math. Routes do not directly touch Prisma.

```
src/
├─ domain/
│  ├─ money.js        rupeesToPaise, paiseToRupees, computeAdvance,
│  │                  reconciliationAdjustment  (pure functions — the math)
│  └─ errors.js       AppError + ValidationError/NotFound/Conflict/
│                     BusinessRule/RateLimit  (each carries http status + code)
├─ db/
│  └─ prisma.js       PrismaClient singleton + warmup() + runTransaction() (retry)
├─ services/          ← business logic, each is transactional
│  ├─ paymentGateway.js   PaymentGateway class (swappable; mock impl)
│  ├─ ledger.js           applyBalanceChange() — writes cache + ledger atomically
│  ├─ userService.js      createUser, getUserByHandleOrId, serializeUser
│  ├─ brandService.js
│  ├─ saleService.js
│  ├─ advancePayoutService.js   runAdvancePayoutJob()  ← idempotent
│  ├─ reconciliationService.js  reconcileSale(), reconcileMany()
│  ├─ withdrawalService.js      initiateWithdrawal()   ← 24h + balance + idempotency
│  └─ payoutService.js          settlePayout()         ← failed-payout recovery
└─ api/
   ├─ app.js          express app assembly
   ├─ middleware/     asyncHandler, validate (zod), errorHandler
   └─ routes/         users, brands, sales, payouts, jobs
```

`PaymentGateway` is kept as an interface with a mock implementation. I did this
so the core payout logic does not depend on one provider from day one.

---

## 5. APIs

| Method & path | Purpose |
|---|---|
| `POST /users` | create a user |
| `GET /users/:handle` | user + withdrawable balance |
| `GET /users/:handle/payouts` | payout history |
| `GET /users/:handle/ledger` | balance-transaction audit trail |
| `POST /users/:handle/withdrawals` | **initiate withdrawal** `{ amount?, idempotencyKey? }` (omit amount ⇒ full balance) |
| `POST /brands` · `GET /brands` | create / list brands |
| `POST /sales` | create pending sale `{ userId, brand, earning }` |
| `GET /sales` · `GET /sales/:id` | list / fetch sales |
| `POST /sales/:id/reconcile` | **reconcile** `{ status: approved\|rejected }` |
| `POST /jobs/advance-payout` | **run advance payout job** `{ userId? }` (idempotent) |
| `POST /payouts/:id/settle` | **gateway webhook sim** `{ status: completed\|failed\|cancelled\|rejected }` → drives recovery |
| `GET /payouts` | list payouts |

Errors return this shape: `{ "error": { "code", "message", "details?" } }`.
The route also sends the matching HTTP status.

---

## 6. Concurrency, idempotency, and edge cases

The main trick is to use guarded updates. Instead of reading a row and then
hoping nobody changed it, the update itself checks the current state:

```js
updateMany({ where: <expected current state>, data: <next state> })
```

If `count === 0`, someone else already changed that row. This is used for
advance payout, reconciliation, and withdrawal balance debit.

I avoided relying on long `SELECT ... FOR UPDATE` style locks because the app is
made for pooled/serverless Postgres. The guarded update style is simpler to run
there and easier to reason about in this project.

### 6.1 Advance payout — avoid paying twice

1. **Candidate filter**: job only selects sales with `advancePaidAt IS NULL`.
2. **Atomic claim**: each sale is claimed with
   `updateMany({ where: { status:'PENDING', advancePaidAt: null }, data: { advancePaidAt: now, advancePaidAmount } })`.
   Only one runner can flip the flag. Others get `count === 0` and skip.
3. **`UNIQUE(payouts.saleId)`**: the DB rejects a duplicate advance row. If
   something slips past the first two checks, the DB still stops it.

The order is claim sale, call gateway, then write the payout row. If the gateway
throws, the transaction rolls back and `advancePaidAt` stays null, so the next
job can try again.

### 6.2 Reconciliation

- Guarded update: `where status='PENDING' AND reconciledAt IS NULL`. Only the
  first caller flips the sale. A second attempt gets **409 `ALREADY_RECONCILED`**.
- Works whether or not the advance ran: if `advancePaidAmount = 0`, an approved
  sale credits the full earning and a rejected sale adjusts by 0.
- The sale flip, the balance change, and the ledger entry all commit together in
  one transaction.

### 6.3 Withdrawal restriction (1 / 24h)

`enforceWithdrawalWindow` checks for a withdrawal in the last 24h with active
status: `PENDING`, `PROCESSING`, or `COMPLETED`. If it finds one, the API returns
**429 `WITHDRAWAL_RATE_LIMITED`** with `nextAllowedAt`.

Failed/cancelled/rejected withdrawals are not counted, because the user should
be able to retry after the money is returned.

### 6.4 Withdrawal correctness

- Amount must be `> 0` and `≤ withdrawableBalance` else **422
  `INVALID_AMOUNT` / `INSUFFICIENT_BALANCE`**. Omitting `amount` withdraws the
  full balance.
- `idempotencyKey` makes "initiate withdrawal" safe to retry: a replay returns
  the original payout (no second debit). Concurrent same-key requests are
  resolved by the `UNIQUE(idempotencyKey)` constraint.
- The balance is debited **at initiation** with an **atomic guarded decrement**
  `updateMany({ where: { withdrawableBalance: { gte: amount } }, data: { decrement } })`.
  Two concurrent withdrawals cannot overdraw: the second gets `count === 0` and
  the transaction rolls back. This happens in the same transaction that creates
  the payout.

### 6.5 Failed payout recovery (`settlePayout`)

This simulates the gateway webhook.
- `completed` → mark `COMPLETED` (balance already debited; nothing to do).
- `failed/cancelled/rejected` → mark terminal **and** credit the amount back
  (`WITHDRAWAL_REVERSAL`), restoring the balance.
- Only a **non-terminal** payout can be settled. A duplicate/replayed webhook
  hits **409 `ALREADY_SETTLED`**, so it does not refund twice.

### 6.6 Negative balances

If many sales are rejected after advances were already paid, the user's
`withdrawableBalance` can become negative. I allowed this because it represents
real debt. Future approved sale credits reduce that negative balance. Withdrawals
stay blocked until the balance is positive again.

### 6.7 No deadlocks, no lost updates

The code does not hold explicit multi-row locks. It mostly uses single guarded
updates. That means there is less lock ordering to manage. Correctness comes from
the `where` guard and checking `count`, not from keeping a lock open across many
statements.

### 6.8 Connection resilience (pooled / serverless Postgres)

The app is meant to work with a pooled Neon DB and Vercel-style deployment.

- **`connection_limit=1`** keeps the process from opening too many DB
  connections.
- **`warmup()`** runs a small `SELECT 1` on boot and retries, because hosted DBs
  can be cold on the first hit.
- **`runTransaction()`** retries transient Prisma/pooler errors
  (`P1001/P2024/P2028`). This is okay because the writes are guarded, so retrying
  does not mean blindly applying the same money change twice.

---

## 7. Trade-offs and alternatives

- **Cached balance + ledger**: I picked this because balance reads are simple and
  there is still a history of every change. The downside is writing both the user
  row and ledger row together every time.
- **Per-sale advance rows**: one payout row per advanced sale makes duplicate
  prevention easier with `UNIQUE(saleId)`. A single aggregate advance looked
  simpler, but then tracing and retry handling become harder.
- **Guarded updates**: this avoids depending too much on DB session locks. The
  trade-off is that the app has to handle `count === 0` and decide what it means.
- **Mock payment gateway**: a real gateway would add webhooks, auth, and provider
  edge cases. For this project I kept it mocked so the payout rules are clear.
- **Gateway mode**: `auto` keeps withdrawals pending so failure recovery can be
  tested. `always` completes them immediately for a simpler run.
