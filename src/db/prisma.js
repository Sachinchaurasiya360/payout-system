import { PrismaClient } from '@prisma/client';


export const prisma = new PrismaClient({
  transactionOptions: { maxWait: 10_000, timeout: 20_000 },
});

const RETRYABLE = new Set(['P1001', 'P2024', 'P2028']);


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


