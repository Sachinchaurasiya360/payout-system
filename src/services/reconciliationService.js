import { prisma, lockRowForUpdate } from '../db/prisma.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { reconciliationAdjustment, paiseToRupees } from '../domain/money.js';
import { applyBalanceChange } from './ledger.js';

const ALLOWED_TARGETS = { approved: 'APPROVED', rejected: 'REJECTED' };

/**
 * Reconcile a single sale (admin action), moving it from PENDING to
 * APPROVED or REJECTED and applying the resulting balance adjustment:
 *
 *   APPROVED : + (earning - advancePaid)   credited to withdrawable balance
 *   REJECTED : - (advancePaid)             clawed back (user got money they
 *                                          were not entitled to)
 *
 * Only PENDING sales can be reconciled; a second attempt is a 409 so an
 * adjustment can never be applied twice. Lock order is user -> sale (a global
 * convention that avoids deadlocks with the withdrawal/settlement paths).
 */
export async function reconcileSale({ saleId, status }) {
  const target = ALLOWED_TARGETS[String(status).toLowerCase()];
  if (!target) {
    throw new ValidationError('status must be "approved" or "rejected"');
  }

  return prisma.$transaction(async (tx) => {
    // Discover the owning user, then lock user before sale.
    const preview = await tx.sale.findUnique({
      where: { id: saleId },
      select: { userId: true },
    });
    if (!preview) throw new NotFoundError(`Sale "${saleId}" not found`);

    await lockRowForUpdate(tx, 'users', preview.userId);
    await lockRowForUpdate(tx, 'sales', saleId);

    const sale = await tx.sale.findUnique({ where: { id: saleId } });
    if (sale.status !== 'PENDING' || sale.reconciledAt) {
      throw new ConflictError(
        `Sale "${saleId}" is already reconciled (status=${sale.status})`,
        'ALREADY_RECONCILED',
      );
    }

    const adjustment = reconciliationAdjustment(target, sale.earning, sale.advancePaidAmount);

    const updatedSale = await tx.sale.update({
      where: { id: saleId },
      data: { status: target, reconciledAt: new Date() },
    });

    let balanceAfter = null;
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
      sale: updatedSale,
      adjustmentPaise: adjustment,
      adjustment: paiseToRupees(adjustment),
      withdrawableBalancePaise: balanceAfter,
      withdrawableBalance: paiseToRupees(balanceAfter),
    };
  });
}

/**
 * Convenience bulk reconcile: `[{ saleId, status }, ...]`. Each sale is
 * reconciled in its own transaction so one bad entry does not roll back the
 * rest; per-item outcomes are returned.
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
