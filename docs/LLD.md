# User Payout Management System — Low-Level Design

> Node.js + Express + Prisma + PostgreSQL. This document covers the domain model,
> database schema, class/module design, APIs, edge cases, and the key trade-offs.
> The worked example from the brief (final payout **₹68**) is reproduced by
> `src/demo.js`.

---

## 1. Problem, restated

Affiliate sales flow through three states: `pending → approved | rejected`.

1. **Advance payout** — every *pending* sale is eligible for an advance of **10%
   of its earning**. Once an advance has been *successfully transferred* for a
   sale, that sale must **never** be advanced again, even if the job runs many
   times (or concurrently).
2. **Final payout** — when an admin reconciles a sale:
   - **Approved** → the user is owed the remaining amount: `earning − advanceAlreadyPaid`.
   - **Rejected** → the advance already paid was not earned, so it is **clawed
     back**: `− advanceAlreadyPaid`.
   The user's final payout is the sum of these adjustments.
3. **Withdrawal restriction** — a user may make only **one withdrawal per 24
   hours**.
4. **Failed payout recovery** — if an initiated payout is later *cancelled /
   rejected / failed*, the amount is credited back to the user's withdrawable
   balance and they may withdraw it again.

---

## 2. Core modelling decisions

### 2.1 Money is stored as integer *paise*

Every monetary column is an `Int` number of paise (1 ₹ = 100 paise). Floating
point (`0.1 + 0.2 !== 0.3`) is unacceptable in a ledger. The HTTP layer accepts
and returns rupees and converts at the boundary (`src/domain/money.js`).

The advance is `floor(10% of earning)` computed in paise — exact for whole-rupee
earnings (₹40 → 400 paise → ₹4) and never over-advances for fractional ones.

### 2.2 Two distinct money concepts

| Concept | What it is | Where it lives |
|---|---|---|
| **Advance payout** | Money pushed *directly* to the user for a pending sale (10%). | A `Payout` row of type `ADVANCE`, one per sale. **Does not** touch withdrawable balance. |
| **Withdrawable balance** | What the user may withdraw, built up at reconciliation. | Cached on `User.withdrawableBalance`; every change is an append-only `BalanceTransaction`. |

This separation is the crux of the design. An advance is *already in the user's
hands*, so it is **not** part of what they can withdraw. Reconciliation is where
the balance moves, and it **nets out** the advance already paid:

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

### 2.3 The balance is a cached total over an append-only ledger

`User.withdrawableBalance` is a fast-read cache. The **source of truth** is the
sum of `BalanceTransaction.amount`. Both are written **in the same DB
transaction**, so the cache can never drift, and the ledger gives a complete
audit trail (why did the balance change, by how much, referencing which
sale/payout).

---

## 3. Database schema

Full schema in [`prisma/schema.prisma`](../prisma/schema.prisma). Summary:

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

> **Why `saleId` UNIQUE nullable works:** PostgreSQL treats `NULL`s as distinct
> in a unique index, so the many withdrawal payouts (saleId = null) are
> unconstrained, while any two advance payouts for the *same* sale collide.

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

## 4. Module / "class" design

Layered, dependency-inverted. Services never build HTTP responses; routes never
touch Prisma.

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

**PaymentGateway** is an interface with a mock implementation. Every service
depends only on the interface, so swapping in RazorpayX/Cashfree/a bank API
requires zero changes elsewhere.

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

Errors return a consistent body: `{ "error": { "code", "message", "details?" } }`
with an appropriate HTTP status (400/404/409/422/429/500).

### Example flow (curl)

```bash
curl -XPOST localhost:3000/users -H 'content-type: application/json' -d '{"handle":"john_doe"}'
curl -XPOST localhost:3000/brands -H 'content-type: application/json' -d '{"code":"brand_1"}'
# create 3 sales @ ₹40 ...
curl -XPOST localhost:3000/sales -H 'content-type: application/json' -d '{"userId":"john_doe","brand":"brand_1","earning":40}'
# advance payout job (10% of ₹120 = ₹12 transferred)
curl -XPOST localhost:3000/jobs/advance-payout -H 'content-type: application/json' -d '{"userId":"john_doe"}'
# reconcile
curl -XPOST localhost:3000/sales/<id1>/reconcile -H 'content-type: application/json' -d '{"status":"rejected"}'
curl -XPOST localhost:3000/sales/<id2>/reconcile -H 'content-type: application/json' -d '{"status":"approved"}'
# balance is now ₹68 -> withdraw
curl -XPOST localhost:3000/users/john_doe/withdrawals -H 'content-type: application/json' -d '{"amount":68,"idempotencyKey":"wd-1"}'
# if the payout fails, refund + retry:
curl -XPOST localhost:3000/payouts/<payoutId>/settle -H 'content-type: application/json' -d '{"status":"failed"}'
```

---

## 6. Concurrency, idempotency & edge cases

> **Concurrency primitive — atomic guarded updates.** This system runs against a
> pooled (pgBouncer) Postgres, where session-scoped `SELECT … FOR UPDATE` locks
> don't survive transaction-mode pooling. So every state transition is a single
> `updateMany({ where: <expected current state>, data: <next state> })`.
> Postgres applies each such UPDATE atomically under a row lock it takes itself;
> `count === 0` means another writer already moved the row. That single fact
> powers idempotency (advance), single-application (reconcile), and
> no-double-spend (withdraw). Multi-row writes are grouped in an interactive
> transaction, wrapped by `runTransaction()` which retries transient pooler
> errors (P1001/P2024/P2028) — safe precisely because the guards make every
> transaction idempotent.

### 6.1 Advance payout — never pay twice (3 layers)

1. **Candidate filter**: job only selects sales with `advancePaidAt IS NULL`.
2. **Atomic claim**: each sale is claimed with
   `updateMany({ where: { status:'PENDING', advancePaidAt: null }, data: { advancePaidAt: now, advancePaidAmount } })`.
   Exactly one runner flips the flag; a loser gets `count === 0` and skips. This
   defeats the read-modify-write race without a session lock.
3. **`UNIQUE(payouts.saleId)`**: the database physically refuses a duplicate
   advance row. If layers 1–2 were ever bypassed, the insert throws `P2002`,
   which the job treats as a *successful* "already advanced" skip.

**Claim-then-transfer-then-commit ordering:** inside the transaction the sale is
claimed first, then the gateway transfer runs, then the payout row is written.
If the transfer throws, the whole transaction rolls back → the claim is undone →
`advancePaidAt` stays null → the sale is retried next run. So a failed advance
never marks the sale paid, and a successful one is recorded atomically.

### 6.2 Reconciliation

- Atomic guarded update `where status='PENDING' AND reconciledAt IS NULL`. Only
  the first caller flips the sale, so the balance adjustment can never be applied
  twice; a second attempt is **409 `ALREADY_RECONCILED`**.
- Works whether or not the advance ran: if `advancePaidAmount = 0`, an approved
  sale credits the full earning and a rejected sale adjusts by 0.
- The sale flip, the balance change, and the ledger entry all commit together in
  one transaction.

### 6.3 Withdrawal restriction (1 / 24h)

`enforceWithdrawalWindow` looks for the most recent withdrawal in the last 24h
whose status is **active** (`PENDING/PROCESSING/COMPLETED`). If found → **429
`WITHDRAWAL_RATE_LIMITED`** with `nextAllowedAt`. `FAILED/CANCELLED/REJECTED`
withdrawals are **excluded** — which is exactly what allows an immediate retry
after a failed payout (§6.5). The window is configurable (`WITHDRAWAL_WINDOW_HOURS`).

### 6.4 Withdrawal correctness

- Amount must be `> 0` and `≤ withdrawableBalance` else **422
  `INVALID_AMOUNT` / `INSUFFICIENT_BALANCE`**. Omitting `amount` withdraws the
  full balance.
- `idempotencyKey` makes "initiate withdrawal" safe to retry: a replay returns
  the original payout (no second debit). Concurrent same-key requests are
  resolved by the `UNIQUE(idempotencyKey)` constraint.
- The balance is debited **at initiation** with an **atomic guarded decrement**
  `updateMany({ where: { withdrawableBalance: { gte: amount } }, data: { decrement } })`.
  Two concurrent withdrawals can never overdraw: the second gets `count === 0`
  and the transaction rolls back. All within the same transaction that creates
  the payout.

### 6.5 Failed payout recovery (`settlePayout`)

Simulates the gateway's async webhook.
- `completed` → mark `COMPLETED` (balance already debited; nothing to do).
- `failed/cancelled/rejected` → mark terminal **and** credit the amount back
  (`WITHDRAWAL_REVERSAL`), restoring the balance.
- Only a **non-terminal** payout can be settled → a duplicate/replayed webhook
  hits **409 `ALREADY_SETTLED`** and can never double-refund.

### 6.6 Negative balances

If a user's sales are mostly rejected after advances were paid, clawbacks can
drive `withdrawableBalance` negative — a genuine "user owes money" state. We
**allow** it (the debt is real and must be carried), future approved-sale
credits offset it, and withdrawals are blocked while the balance isn't positive.

### 6.7 No deadlocks, no lost updates

Because there are no explicit multi-row `FOR UPDATE` locks — only single-statement
guarded updates — there is no lock-ordering discipline to get wrong and no
deadlock surface. Each guarded `updateMany`/`increment` is atomic at the row
level; correctness comes from the `where` guard + `count` check, not from holding
a lock across statements.

### 6.8 Connection resilience (pooled / serverless Postgres)

The system targets a pooled Neon endpoint (and Vercel serverless). Three measures
keep it reliable there:
- **`connection_limit=1`** on the pooled URL — one client connection per process;
  avoids exhausting the pooler and the P2024 "pool timeout" it causes.
- **`warmup()`** — retries a trivial `SELECT 1` on boot to ride out the free-tier
  compute cold start (auto-suspend → P1001 on the first hit).
- **`runTransaction()`** — retries transient pooler errors (P1001/P2024/P2028);
  safe because every transaction is guarded and idempotent, so a retry re-reads
  and re-applies without side effects.

---

## 7. Trade-offs & alternatives

- **Cached balance + ledger** vs. compute-on-read: caching gives O(1) balance
  reads and a natural audit log at the cost of writing two rows per change. The
  same-transaction guarantee keeps them consistent. Chosen because a payout
  system is read-heavy on balance and demands auditability.
- **Per-sale advance rows** vs. one aggregate advance: per-sale rows make the
  `UNIQUE(saleId)` idempotency guard trivial and give exact traceability; the
  aggregate (₹12) is just their sum.
- **Atomic guarded updates** vs. pessimistic `SELECT … FOR UPDATE`: guarded
  single-statement updates work over pgBouncer/serverless (where session locks
  don't survive transaction pooling), avoid deadlocks entirely, and are cheaper.
  The trade-off is that a "guard failed" outcome surfaces as `count === 0` for
  the app to interpret, rather than a blocking wait.
- **Synchronous advance / webhook-driven withdrawal**: advances are modelled as
  settling immediately (small, low-risk); withdrawals are async and settled via
  `/payouts/:id/settle`, mirroring how real payout providers confirm later.
- **`GATEWAY_MODE`**: `auto` (withdrawals stay PENDING for the demo) vs `always`
  (auto-complete) — lets you exercise the failure path without external infra.

## 8. What a production version would add

Idempotent job runner with a scheduler/queue (BullMQ), gateway webhook signature
verification, outbox pattern for the transfer call (so a crash between DB commit
and gateway call is recoverable), per-user rate limiting at the edge,
authn/authz (admin vs user), pagination on list endpoints, and structured
logging/metrics/tracing.
