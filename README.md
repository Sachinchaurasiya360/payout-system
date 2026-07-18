# User Payout Management System

A Low-Level Design + working implementation of a payout system for affiliate
sales: **advance payouts** (10% of pending earnings), **admin reconciliation**
with final-payout math, a **one-withdrawal-per-24h** rule, and **failed-payout
recovery**.

**Stack:** Node.js · Express · Prisma · PostgreSQL (Neon) · Zod

> Full design write-up (schema, class design, concurrency, edge cases,
> trade-offs): **[docs/LLD.md](docs/LLD.md)**.

---

## The business logic in one table

3 sales @ ₹40, each advanced ₹4 (10%), then reconciled:

| Sale | Outcome | Earning | Advance paid | Balance adjustment |
|------|---------|--------:|-------------:|-------------------:|
| 1 | rejected | ₹40 | ₹4 | **−₹4** (claw back advance) |
| 2 | approved | ₹40 | ₹4 | **+₹36** (remaining 90%) |
| 3 | approved | ₹40 | ₹4 | **+₹36** |
| | | | **Final payout** | **₹68** |

`src/demo.js` reproduces exactly this, then withdraws, fails the payout, and
retries — printing the ledger at each step.

---

## Quick start

```bash
npm install

# 1. Configure the database
cp .env.example .env         # then set DATABASE_URL / DIRECT_URL (Neon or local Postgres)

# 2. Create the schema + seed the reference brands
npm run prisma:generate
npm run prisma:migrate       # or: npx prisma migrate reset --force  (drops + re-applies + seeds)

# 3. See it all work end-to-end (reproduces the ₹68 example)
npm run demo

# 4. Run the HTTP API
npm start                    # http://localhost:3000/health
```

Local Postgres via Docker instead of Neon:

```bash
npm run db:up                # starts postgres:16 on :5432 (see docker-compose.yml)
# set DATABASE_URL / DIRECT_URL to the local docker values, then migrate
```

---

## Environment

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Runtime connection. For Neon use the **pooled** (`-pooler`) URL with `pgbouncer=true`. |
| `DIRECT_URL` | Migrations only. For Neon use the **direct** (non-pooled) URL. |
| `PORT` | API port (default 3000). |
| `GATEWAY_MODE` | `auto` (withdrawals stay PENDING until settled — best for the demo) or `always` (auto-complete). |
| `WITHDRAWAL_WINDOW_HOURS` | Withdrawal cooldown (default 24). |

---

## API

| Method & path | Purpose |
|---|---|
| `GET /health` | liveness |
| `POST /users` `{handle}` | create user |
| `GET /users/:handle` | user + withdrawable balance |
| `GET /users/:handle/payouts` | payout history |
| `GET /users/:handle/ledger` | balance-transaction audit trail |
| `POST /users/:handle/withdrawals` `{amount?, idempotencyKey?}` | initiate withdrawal (24h + balance enforced) |
| `POST /brands` `{code,name?}` · `GET /brands` | create / list brands |
| `POST /sales` `{userId,brand,earning}` | create pending sale |
| `GET /sales?userId=` · `GET /sales/:id` | list / fetch sales |
| `POST /sales/:id/reconcile` `{status}` | approve/reject → applies final-payout adjustment |
| `POST /jobs/advance-payout` `{userId?}` | run the (idempotent) advance-payout job |
| `POST /payouts/:id/settle` `{status,reason?}` | gateway webhook sim → drives failed-payout recovery |

Errors return `{ "error": { "code", "message", "details?" } }` with a matching
HTTP status (400/404/409/422/429).

### Worked example over HTTP

```bash
BASE=http://localhost:3000
curl -s -XPOST $BASE/users  -H 'content-type: application/json' -d '{"handle":"john_doe"}'
curl -s -XPOST $BASE/brands -H 'content-type: application/json' -d '{"code":"brand_1"}'

# three ₹40 pending sales
for i in 1 2 3; do
  curl -s -XPOST $BASE/sales -H 'content-type: application/json' \
    -d '{"userId":"john_doe","brand":"brand_1","earning":40}'
done

# advance payout job — transfers 10% of ₹120 = ₹12 (run it twice; nothing double-pays)
curl -s -XPOST $BASE/jobs/advance-payout -H 'content-type: application/json' -d '{"userId":"john_doe"}'

# reconcile (use the sale ids from GET /sales?userId=john_doe)
curl -s -XPOST $BASE/sales/<id1>/reconcile -H 'content-type: application/json' -d '{"status":"rejected"}'
curl -s -XPOST $BASE/sales/<id2>/reconcile -H 'content-type: application/json' -d '{"status":"approved"}'
curl -s -XPOST $BASE/sales/<id3>/reconcile -H 'content-type: application/json' -d '{"status":"approved"}'

# balance is now ₹68 — withdraw it
curl -s -XPOST $BASE/users/john_doe/withdrawals -H 'content-type: application/json' \
  -d '{"amount":68,"idempotencyKey":"wd-1"}'

# if the payout fails, the amount is refunded and can be withdrawn again
curl -s -XPOST $BASE/payouts/<payoutId>/settle -H 'content-type: application/json' -d '{"status":"failed"}'
```

---

## Project layout

```
prisma/schema.prisma        data model (see docs/LLD.md §3)
prisma/migrations/          SQL migration + lock
prisma/seed.js              seeds brand_1..3
src/domain/                 money math + typed errors (pure, no I/O)
src/db/prisma.js            PrismaClient + FOR UPDATE row-lock helper
src/services/               business logic (transactional)
src/api/                    express app, routes, middleware
src/server.js               HTTP entrypoint
src/demo.js                 end-to-end walkthrough
api/index.js                Vercel serverless entrypoint
```

## Key guarantees

- **Money as integer paise** — no floating-point drift.
- **Advance idempotency** — filter + `SELECT … FOR UPDATE` re-check + `UNIQUE(saleId)`.
- **Atomic balance** — cached `User.withdrawableBalance` and the append-only
  `BalanceTransaction` ledger are written in the same transaction.
- **Failed-payout recovery** — only non-terminal payouts settle, so a refund can
  never be applied twice; failed withdrawals don't count toward the 24h limit,
  enabling immediate retry.

See **[docs/LLD.md](docs/LLD.md)** for the full rationale.
