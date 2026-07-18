/**
 * Applies a signed change to a user's withdrawable balance AND records the
 * matching append-only ledger entry, inside the caller's transaction.
 *
 * `increment` compiles to an atomic `SET balance = balance + $delta` (Postgres
 * takes the row lock itself) and returns the updated row, so `balanceAfter` is
 * always consistent even under concurrent balance changes. Use this for credits
 * and clawbacks that have no lower bound; guarded debits that must not overdraw
 * (withdrawals) use a `where balance >= amount` updateMany instead.
 */
export async function applyBalanceChange(
  tx,
  { userId, amount, type, saleId = null, payoutId = null, reason = null },
) {
  const user = await tx.user.update({
    where: { id: userId },
    data: { withdrawableBalance: { increment: amount } },
  });

  await tx.balanceTransaction.create({
    data: {
      userId,
      amount,
      type,
      balanceAfter: user.withdrawableBalance,
      saleId,
      payoutId,
      reason,
    },
  });

  return user.withdrawableBalance;
}
