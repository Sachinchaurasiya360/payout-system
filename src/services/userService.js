import { prisma } from '../db/prisma.js';
import { NotFoundError, ConflictError } from '../domain/errors.js';
import { paiseToRupees } from '../domain/money.js';

export async function createUser({ handle }) {
  const existing = await prisma.user.findUnique({ where: { handle } });
  if (existing) {
    throw new ConflictError(`User "${handle}" already exists`, 'USER_EXISTS');
  }
  return prisma.user.create({ data: { handle } });
}

/** Look up by internal id or by human handle. Throws NotFoundError if absent. */
export async function getUserByHandleOrId(handleOrId) {
  const user = await prisma.user.findFirst({
    where: { OR: [{ handle: handleOrId }, { id: handleOrId }] },
  });
  if (!user) throw new NotFoundError(`User "${handleOrId}" not found`);
  return user;
}

export function serializeUser(user) {
  return {
    id: user.id,
    handle: user.handle,
    withdrawableBalancePaise: user.withdrawableBalance,
    withdrawableBalance: paiseToRupees(user.withdrawableBalance),
    createdAt: user.createdAt,
  };
}
