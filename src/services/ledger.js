/**
 * Applies a signed change to a user's withdrawable balance AND records the
 * matching append-only ledger entry, inside the caller's transaction.
 *
 * Preconditions: the caller must already hold a FOR UPDATE lock on the user
 * row (see lockRowForUpdate) so concurrent balance changes serialise.
 *
 * `increment` compiles to an atomic `SET balance = balance + $delta` and
 * returns the updated row, so `balanceAfter` is always consistent.
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
