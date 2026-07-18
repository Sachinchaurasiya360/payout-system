import { runTransaction } from '../db/prisma.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { reconciliationAdjustment, paiseToRupees } from '../domain/money.js';
import { applyBalanceChange } from './ledger.js';

const ALLOWED_TARGETS = { approved: 'APPROVED', rejected: 'REJECTED' };

/**
 * Reconcile a single sale (admin action): PENDING -> APPROVED/REJECTED, and
 * apply the resulting balance adjustment:
 *
 *   APPROVED : + (earning - advancePaid)   credited to withdrawable balance
 *   REJECTED : - (advancePaid)             clawed back (user got money they
 *                                          were not entitled to)
 *
 * The atomic guarded update (`where status=PENDING & reconciledAt=null`) makes
 * this safe under concurrency: only the first caller flips the sale, so the
 * adjustment can never be applied twice. A second attempt is a 409.
 */
export async function reconcileSale({ saleId, status }) {
  const target = ALLOWED_TARGETS[String(status).toLowerCase()];
  if (!target) {
    throw new ValidationError('status must be "approved" or "rejected"');
  }

  return runTransaction(async (tx) => {
    const existing = await tx.sale.findUnique({ where: { id: saleId } });
    if (!existing) throw new NotFoundError(`Sale "${saleId}" not found`);

    // Atomic claim: only a still-PENDING, not-yet-reconciled sale is updated.
    const claim = await tx.sale.updateMany({
      where: { id: saleId, status: 'PENDING', reconciledAt: null },
      data: { status: target, reconciledAt: new Date() },
    });
    if (claim.count === 0) {
      throw new ConflictError(
        `Sale "${saleId}" is already reconciled (status=${existing.status})`,
        'ALREADY_RECONCILED',
      );
    }

    // Re-read to compute the adjustment from authoritative values.
    const sale = await tx.sale.findUnique({ where: { id: saleId } });
    const adjustment = reconciliationAdjustment(target, sale.earning, sale.advancePaidAmount);

    let balanceAfter;
    if (adjustment !== 0) {
      balanceAfter = await applyBalanceChange(tx, {
        userId: sale.userId,
        amount: adjustment,
        type: target === 'APPROVED' ? 'RECONCILIATION_CREDIT' : 'RECONCILIATION_CLAWBACK',
        saleId,
        reason: `Reconciled sale to ${target}`,
      });
    } else {
      const user = await tx.user.findUnique({ where: { id: sale.userId } });
      balanceAfter = user.withdrawableBalance;
    }

    return {
      sale,
      adjustmentPaise: adjustment,
      adjustment: paiseToRupees(adjustment),
      withdrawableBalancePaise: balanceAfter,
      withdrawableBalance: paiseToRupees(balanceAfter),
    };
  });
}

/**
 * Bulk reconcile: `[{ saleId, status }, ...]`. Each sale is reconciled in its
 * own transaction so one bad entry does not roll back the rest.
 */
export async function reconcileMany(entries) {
  const items = [];
  for (const entry of entries) {
    try {
      const res = await reconcileSale(entry);
      items.push({ saleId: entry.saleId, ok: true, adjustment: res.adjustment });
    } catch (err) {
      items.push({ saleId: entry.saleId, ok: false, code: err.code, error: err.message });
    }
  }
  return items;
}
