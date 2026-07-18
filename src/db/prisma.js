import { PrismaClient } from '@prisma/client';

/**
 * Single shared PrismaClient for the process. Creating one per request would
 * exhaust the connection pool.
 */
export const prisma = new PrismaClient({
  // Generous transaction window: pooled/serverless Postgres can be slow to hand
  // back a connection on a cold path, and the default 5s timeout is too tight.
  transactionOptions: { maxWait: 10_000, timeout: 20_000 },
});

// Transient errors worth retrying against a pooled/serverless database:
//  P1001 can't reach server · P2024 pool timeout · P2028 transaction dropped by the pooler.
const RETRYABLE = new Set(['P1001', 'P2024', 'P2028']);

/**
 * Run an interactive transaction with automatic retry on transient pooler
 * errors. This is safe because every transaction in this system is expressed as
 * guarded, idempotent updates: a retryable error means the transaction never
 * committed, and re-running re-reads state and re-applies the same guards.
 */
export async function runTransaction(fn, { retries = 4, delayMs = 1500 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await prisma.$transaction(fn);
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE.has(err?.code) || attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
      await warmup().catch(() => {}); // best-effort: re-wake before retrying
    }
  }
  throw lastErr;
}

/**
 * Wake / warm up the database connection with retries.
 *
 * Serverless Postgres (Neon free tier) auto-suspends the compute after a few
 * minutes idle; the first connection has to wake it, which can exceed the
 * driver's connect timeout and surface as P1001. A few retries with backoff
 * ride out the cold start. Call once before a batch of work (scripts, demo,
 * server boot).
 */
export async function warmup({ retries = 12, delayMs = 2500 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch (err) {
      const last = attempt === retries;
      const reachable = !String(err?.message || '').includes("Can't reach");
      if (last || reachable) throw err; // only retry connectivity errors
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/**
 * Concurrency strategy note
 * -------------------------
 * This system runs against a pooled (pgBouncer) Postgres — the norm for
 * serverless/Neon. Session-scoped `SELECT ... FOR UPDATE` locks do not survive
 * transaction-mode pooling, so instead of pessimistic row locks we use ATOMIC
 * GUARDED UPDATES: every state transition is expressed as a single
 * `updateMany({ where: <expected current state>, data: <next state> })`.
 *
 * Postgres applies each such UPDATE atomically under row-level locks it takes
 * itself, and `count === 0` tells us another writer already moved the row —
 * which is exactly the check we need for idempotency and no-double-spend. The
 * `increment`/`decrement` operators are likewise atomic (`SET x = x ± n`).
 * All related writes are still wrapped in an interactive transaction so they
 * commit together.
 */
