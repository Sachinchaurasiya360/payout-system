/**
 * End-to-end demo. Run with: `npm run demo`
 *
 * Reproduces the assignment's worked example (final payout = ₹68) and then
 * exercises every business rule:
 *   - advance payout + idempotency (job run twice)
 *   - reconciliation math (approved credit, rejected clawback)
 *   - one-withdrawal-per-24h restriction
 *   - failed-payout recovery (refund + immediate retry)
 *
 * Uses the service layer directly (no HTTP) against the configured Postgres.
 */
import { prisma, warmup } from './db/prisma.js';
import { createUser, getUserByHandleOrId, serializeUser } from './services/userService.js';
import { createSale, listSales, serializeSale } from './services/saleService.js';
import { runAdvancePayoutJob } from './services/advancePayoutService.js';
import { reconcileSale } from './services/reconciliationService.js';
import { initiateWithdrawal } from './services/withdrawalService.js';
import { settlePayout, getLedger } from './services/payoutService.js';
import { getBrandByCodeOrId } from './services/brandService.js';

const line = (title) => console.log(`\n${'='.repeat(4)} ${title} ${'='.repeat(Math.max(0, 60 - title.length))}`);

async function balanceOf(handle) {
  const u = await getUserByHandleOrId(handle);
  return serializeUser(u).withdrawableBalance;
}

async function main() {
  // Unique handle per run so the demo is re-runnable without a DB reset.
  const handle = `john_doe_${Date.now()}`;

  line('SETUP');
  process.stdout.write('Waking database... ');
  await warmup();
  console.log('ready');
  await prisma.brand.upsert({
    where: { code: 'brand_1' },
    update: {},
    create: { code: 'brand_1', name: 'Brand One' },
  });
  await createUser({ handle });
  console.log(`Created user: ${handle}`);

  const sales = [];
  for (let i = 0; i < 3; i += 1) {
    sales.push(await createSale({ userId: handle, brand: 'brand_1', earning: 40 }));
  }
  console.log(`Created 3 PENDING sales @ ₹40 each (total pending earnings ₹120)`);

  line('ADVANCE PAYOUT JOB (run #1)');
  const run1 = await runAdvancePayoutJob({ userId: handle });
  console.log(`paid=${run1.paid} skipped=${run1.skipped} failed=${run1.failed}` +
    ` | total advance transferred = ${run1.totalTransferred} (expected ₹12 = 10% of ₹120)`);

  line('ADVANCE PAYOUT JOB (run #2 — idempotency check)');
  const run2 = await runAdvancePayoutJob({ userId: handle });
  console.log(`paid=${run2.paid} skipped=${run2.skipped} failed=${run2.failed}` +
    ` | total transferred this run = ${run2.totalTransferred} (expected ₹0 — nothing paid twice)`);

  line('RECONCILIATION');
  const outcomes = ['rejected', 'approved', 'approved'];
  for (let i = 0; i < sales.length; i += 1) {
    const r = await reconcileSale({ saleId: sales[i].id, status: outcomes[i] });
    console.log(
      `Sale ${i + 1}: ${outcomes[i].padEnd(8)} earning ₹40, advance ₹4 -> adjustment ${r.adjustment >= 0 ? '+' : ''}${r.adjustment}` +
        ` | running balance ₹${r.withdrawableBalance}`,
    );
  }
  const finalBalance = await balanceOf(handle);
  console.log(`\n>>> FINAL PAYOUT (withdrawable balance) = ${finalBalance} (expected ₹68)`);

  line('WITHDRAWAL #1 (₹30)');
  const w1 = await initiateWithdrawal({ userId: handle, amount: 30, idempotencyKey: 'wd-1' });
  console.log(`Withdrawal ${w1.payout.id} status=${w1.payout.status} | balance now ₹${w1.withdrawableBalance}`);

  line('WITHDRAWAL #2 attempt within 24h (₹10) — expect RATE LIMIT');
  try {
    await initiateWithdrawal({ userId: handle, amount: 10, idempotencyKey: 'wd-2' });
    console.log('ERROR: should have been blocked!');
  } catch (err) {
    console.log(`Blocked as expected -> [${err.code}] ${err.message}`);
  }

  line('FAILED PAYOUT RECOVERY — settle withdrawal #1 as FAILED');
  const settled = await settlePayout({ payoutId: w1.payout.id, status: 'failed', reason: 'bank_returned' });
  console.log(`Payout ${settled.payout.id} status=${settled.payout.status}, refunded=${settled.refunded}` +
    ` | balance restored to ₹${settled.withdrawableBalance}`);

  line('RETRY WITHDRAWAL after failure (₹10) — now ALLOWED');
  const w3 = await initiateWithdrawal({ userId: handle, amount: 10, idempotencyKey: 'wd-3' });
  console.log(`Withdrawal ${w3.payout.id} status=${w3.payout.status} | balance now ₹${w3.withdrawableBalance}`);

  line('SETTLE retry withdrawal as COMPLETED');
  const done = await settlePayout({ payoutId: w3.payout.id, status: 'completed' });
  console.log(`Payout ${done.payout.id} status=${done.payout.status} | balance ₹${done.withdrawableBalance}`);

  line('FINAL STATE');
  const salesNow = await listSales({ userId: handle });
  for (const s of salesNow) {
    const brand = await getBrandByCodeOrId(s.brandId);
    const v = serializeSale(s, brand);
    console.log(`  sale ${v.id.slice(-6)} ${v.status.padEnd(8)} earning ₹${v.earning} advance ₹${v.advancePaid}`);
  }
  console.log('\n  Balance ledger:');
  for (const e of await getLedger(handle)) {
    console.log(
      `    ${e.type.padEnd(24)} ${(e.amount >= 0 ? '+' : '') + e.amount}`.padEnd(44) +
        `-> balance ₹${e.balanceAfter}`,
    );
  }
  console.log(
    `\n  Withdrawable balance: ₹${await balanceOf(handle)} (expected ₹58: ₹68 - ₹10 completed withdrawal;` +
      ` the failed ₹30 was refunded)`,
  );
}

main()
  .catch((err) => {
    console.error('\nDEMO FAILED:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
