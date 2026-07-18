import { prisma } from '../db/prisma.js';
import { NotFoundError, ConflictError } from '../domain/errors.js';

export async function createBrand({ code, name }) {
  const existing = await prisma.brand.findUnique({ where: { code } });
  if (existing) {
    throw new ConflictError(`Brand "${code}" already exists`, 'BRAND_EXISTS');
  }
  return prisma.brand.create({ data: { code, name: name ?? code } });
}

export async function getBrandByCodeOrId(codeOrId) {
  const brand = await prisma.brand.findFirst({
    where: { OR: [{ code: codeOrId }, { id: codeOrId }] },
  });
  if (!brand) throw new NotFoundError(`Brand "${codeOrId}" not found`);
  return brand;
}

export function listBrands() {
  return prisma.brand.findMany({ orderBy: { code: 'asc' } });
}
