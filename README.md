# User Payout Management System

**Live demo:** [https://payout-management-system-swart.vercel.app/](https://payout-management-system-swart.vercel.app/)

**LLD diagram:** [https://excalidraw.com/#json=g9vuxxaLsrvpVhXag7AKM,BP8IMaVo7wOHi7zCCJnGUw](https://excalidraw.com/#json=g9vuxxaLsrvpVhXag7AKM,BP8IMaVo7wOHi7zCCJnGUw)

A payout system for affiliate sales. It pays users an advance of 10% on their
pending earnings, lets an admin reconcile each sale later to settle the final
amount owed, limits users to one withdrawal every 24 hours, and recovers cleanly
when a payout fails at the gateway.

The repository holds both the design write-up and a working implementation. The
full reasoning behind it — the schema, the class design, the concurrency model,
and the edge cases behind each decision — lives in [docs/LLD.md](docs/LLD.md).

Built with Node.js, Express, Prisma, and PostgreSQL (Neon), with Zod for request
validation.

## The core idea, in one example

The system is easiest to follow by watching three sales move through it. Say a
user records three sales of ₹40 each. While they're still pending, each one earns
a 10% advance of ₹4. Later an admin reconciles them, and the balance settles like
this:

| Sale | Outcome | Earning | Advance paid | Balance adjustment |
|------|---------|--------:|-------------:|-------------------:|
| 1 | rejected | ₹40 | ₹4 | −₹4 (advance clawed back) |
| 2 | approved | ₹40 | ₹4 | +₹36 (the remaining 90%) |
| 3 | approved | ₹40 | ₹4 | +₹36 |
| | | | Final payout | ₹68 |

`src/demo.js` walks through exactly this scenario: it runs the advance,
reconciles each sale, withdraws the balance, fails the payout, and retries —
printing the ledger at every step so you can watch the numbers move.

## Getting started

```bash
npm install

# 1. Point it at a database
cp .env.example .env         # then fill in DATABASE_URL / DIRECT_URL (Neon or local Postgres)

# 2. Create the schema and seed the reference brands
npm run prisma:generate
npm run prisma:migrate       # or: npx prisma migrate reset --force to drop, recreate, and reseed

# 3. Run the end-to-end walkthrough (reproduces the ₹68 example above)
npm run demo

# 4. Start the API + web console
npm start                    # http://localhost:3000
```

Prefer a local Postgres over Neon? There's a Docker setup:

```bash
npm run db:up                # starts postgres:16 on :5432 (see docker-compose.yml)
# point DATABASE_URL / DIRECT_URL at the local instance, then run the migrate step above
```

## Web console

`npm start` also serves a small web console at
[http://localhost:3000](http://localhost:3000) — a single-page dashboard (static
HTML/CSS/JS, no build step) that drives the whole API: create users and brands,
add sales, run the advance-payout job, reconcile, withdraw, and settle payouts,
all with a live balance, sales/payouts tables, and the balance ledger. Hit
**"Scaffold a demo account"** to spin up a user with three ₹40 sales and start
clicking. The files live in [public/](public/).

## Different approaches I thought about

### Approach 1

First idea was to pay the 10% advance directly when a sale is created. It looks
simple because one request creates the sale and also starts the payout. But this
mixes two different things. If many sales come in together, this can send too
many payout requests from the normal sale API. If the gateway is slow or fails,
then creating a sale also becomes slow or messy.

### Approach 2

Another idea was to keep a separate advance-payout job. Sale creation only saves
pending sales, and the job later picks the eligible ones. This is better because
the sale API stays clean. The problem is that the job must be careful. If two job
runs pick the same sale, it can double-pay unless there are guards like
`advancePaidAt` and unique payout records.

### Approach 3

I also thought about keeping only one balance number on the user table and not
making a ledger table. That would be easier to build at first. But later it
becomes tough to manage because there is no proper history. If a payout fails,
or an advance is clawed back, or the user asks why the balance changed, there is
nothing clear to show.

### Approach 4

Another option was to not store the balance and calculate it every time from
sales, payouts, and reversals. This is okay for small data, but it has poor load
isolation. A simple balance screen and a withdrawal request both start depending
on heavy aggregation queries. Later, if sales volume grows, the withdrawal path
can become slow because it has to read too much history before deciding if the
user can withdraw. So I kept a cached balance and ledger: the ledger gives
history, and the cached balance keeps the hot withdrawal path small.

### Approach 5

I also thought about calling a real payout provider directly from the service
logic. That feels more real, but it mixes provider failures with core balance
logic. If the provider is slow, rate-limited, or sends duplicate webhooks, the
main money code becomes harder to manage. I kept the payment gateway behind an
interface so provider retries, webhook handling, and gateway-specific details
stay isolated. The service only cares whether a payout moved to completed or
failed, not how the provider works inside.

## API

| Method & path | What it does |
|---|---|
| `GET /health` | liveness check |
| `POST /users` `{handle}` | create a user |
| `GET /users/:handle` | user details plus withdrawable balance |
| `GET /users/:handle/payouts` | payout history |
| `GET /users/:handle/ledger` | the balance-transaction audit trail |
| `POST /users/:handle/withdrawals` `{amount?, idempotencyKey?}` | start a withdrawal (the 24h cooldown and the balance are both enforced) |
| `POST /brands` `{code,name?}` · `GET /brands` | create or list brands |
| `POST /sales` `{userId,brand,earning}` | record a pending sale |
| `GET /sales?userId=` · `GET /sales/:id` | list or fetch sales |
| `POST /sales/:id/reconcile` `{status}` | approve or reject a sale, applying the final-payout adjustment |
| `POST /jobs/advance-payout` `{userId?}` | run the advance-payout job (safe to run more than once) |
| `POST /payouts/:id/settle` `{status,reason?}` | simulate the gateway webhook that drives failed-payout recovery |

Errors come back as `{ "error": { "code", "message", "details?" } }` with a
matching HTTP status (400, 404, 409, 422, or 429).

## What the system guarantees

- **Money is stored as integer paise**, so no balance ever suffers floating-point
  drift.
- **An advance can't be paid twice.** The job filters for un-advanced sales,
  atomically claims each one, and leans on a `UNIQUE(saleId)` constraint as a
  final backstop — so even concurrent runs settle to a single advance per sale.
- **The balance and the ledger stay in lockstep.** The cached
  `withdrawableBalance` on the user and the append-only `BalanceTransaction`
  entries are written in the same transaction, so they can never disagree.
- **Failed payouts recover cleanly.** Only a non-terminal payout can be settled,
  so a refund is never applied twice, and a failed withdrawal doesn't count
  against the 24-hour limit — which lets the user simply try again.

The reasoning behind all of this is in [docs/LLD.md](docs/LLD.md).
