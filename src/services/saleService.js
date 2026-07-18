import { prisma } from '../db/prisma.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import { rupeesToPaise, paiseToRupees } from '../domain/money.js';
import { getUserByHandleOrId } from './userService.js';
import { getBrandByCodeOrId } from './brandService.js';

/**
 * Create a new sale. Sales always enter as PENDING (a purchase that has not yet
 * been reconciled). `earning` is provided in rupees and stored as paise.
 */
export async function createSale({ userId, brand, earning }) {
  if (typeof earning !== 'number' || earning <= 0) {
    throw new ValidationError('earning must be a positive number of rupees');
  }
  const user = await getUserByHandleOrId(userId);
  const brandRecord = await getBrandByCodeOrId(brand);

  return prisma.sale.create({
    data: {
      userId: user.id,
      brandId: brandRecord.id,
      earning: rupeesToPaise(earning),
      status: 'PENDING',
    },
  });
}

export async function getSaleById(id) {
  const sale = await prisma.sale.findUnique({ where: { id } });
  if (!sale) throw new NotFoundError(`Sale "${id}" not found`);
  return sale;
}

export async function listSales({ userId } = {}) {
  const where = {};
  if (userId) {
    const user = await getUserByHandleOrId(userId);
    where.userId = user.id;
  }
  return prisma.sale.findMany({ where, orderBy: { createdAt: 'asc' } });
}

export function serializeSale(sale, brand) {
  return {
    id: sale.id,
    userId: sale.userId,
    brand: brand?.code,
    status: sale.status.toLowerCase(),
    earning: paiseToRupees(sale.earning),
    earningPaise: sale.earning,
    advancePaid: paiseToRupees(sale.advancePaidAmount),
    advancePaidPaise: sale.advancePaidAmount,
    advancePaidAt: sale.advancePaidAt,
    reconciledAt: sale.reconciledAt,
    createdAt: sale.createdAt,
  };
}
