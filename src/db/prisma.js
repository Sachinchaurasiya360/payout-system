import { PrismaClient } from '@prisma/client';

/**
 * Single shared PrismaClient for the process. Creating one per request would
 * exhaust the Postgres connection pool.
 */
export const prisma = new PrismaClient();

/**
 * Row-lock helper used inside interactive transactions.
 *
 * Prisma has no first-class `SELECT ... FOR UPDATE`, so we issue a raw locking
 * read. This serialises concurrent operations that touch the same user/sale
 * row (advance-payout job vs. reconciliation vs. withdrawal), preventing the
 * classic read-modify-write race on balances and advance flags.
 *
 * `table` is a trusted internal constant (never user input) — safe to inline.
 */
export async function lockRowForUpdate(tx, table, id) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`,
    id,
  );
  return rows.length > 0 ? rows[0] : null;
}
