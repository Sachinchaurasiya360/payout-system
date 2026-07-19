# User Payout Management System

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

# 4. Start the API
npm start                    # http://localhost:3000/health
```

Prefer a local Postgres over Neon? There's a Docker setup:

```bash
npm run db:up                # starts postgres:16 on :5432 (see docker-compose.yml)
# point DATABASE_URL / DIRECT_URL at the local instance, then run the migrate step above
```

## Configuration

A handful of environment variables drive everything:

| Variable | What it does |
|----------|--------------|
| `DATABASE_URL` | The connection used at runtime. On Neon, use the pooled (`-pooler`) URL with `pgbouncer=true`. |
| `DIRECT_URL` | Used only when running migrations. On Neon, use the direct, non-pooled URL. |
| `PORT` | The port the API listens on. Defaults to 3000. |
| `GATEWAY_MODE` | `auto` leaves withdrawals PENDING until you settle them by hand (which is what the demo relies on); `always` completes them straight away. |
| `WITHDRAWAL_WINDOW_HOURS` | How long a user waits between withdrawals. Defaults to 24. |

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

### The same flow over HTTP

```bash
BASE=http://localhost:3000
curl -s -XPOST $BASE/users  -H 'content-type: application/json' -d '{"handle":"john_doe"}'
curl -s -XPOST $BASE/brands -H 'content-type: application/json' -d '{"code":"brand_1"}'

# three pending sales of ₹40
for i in 1 2 3; do
  curl -s -XPOST $BASE/sales -H 'content-type: application/json' \
    -d '{"userId":"john_doe","brand":"brand_1","earning":40}'
done

# advance-payout job: pays 10% of ₹120, i.e. ₹12 (run it again — nothing double-pays)
curl -s -XPOST $BASE/jobs/advance-payout -H 'content-type: application/json' -d '{"userId":"john_doe"}'

# reconcile each sale (grab the ids from GET /sales?userId=john_doe)
curl -s -XPOST $BASE/sales/<id1>/reconcile -H 'content-type: application/json' -d '{"status":"rejected"}'
curl -s -XPOST $BASE/sales/<id2>/reconcile -H 'content-type: application/json' -d '{"status":"approved"}'
curl -s -XPOST $BASE/sales/<id3>/reconcile -H 'content-type: application/json' -d '{"status":"approved"}'

# the balance is now ₹68 — withdraw it
curl -s -XPOST $BASE/users/john_doe/withdrawals -H 'content-type: application/json' \
  -d '{"amount":68,"idempotencyKey":"wd-1"}'

# if that payout fails, the money is refunded and can be withdrawn again
curl -s -XPOST $BASE/payouts/<payoutId>/settle -H 'content-type: application/json' -d '{"status":"failed"}'
```

## How the code is organised

```
prisma/schema.prisma        the data model (see docs/LLD.md §3)
prisma/migrations/          SQL migration + lock file
prisma/seed.js              seeds brand_1..3
src/domain/                 money math and typed errors (pure, no I/O)
src/db/prisma.js            PrismaClient and the DB connection helpers
src/services/               the business logic, all transactional
src/api/                    the Express app, routes, and middleware
src/server.js               HTTP entrypoint
src/demo.js                 the end-to-end walkthrough
```

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
