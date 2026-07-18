/**
 * Seeds the three reference brands. Run with: `npm run seed`
 * Safe to run repeatedly (upsert).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const BRANDS = [
  { code: 'brand_1', name: 'Brand One' },
  { code: 'brand_2', name: 'Brand Two' },
  { code: 'brand_3', name: 'Brand Three' },
];

async function main() {
  for (const b of BRANDS) {
    await prisma.brand.upsert({ where: { code: b.code }, update: {}, create: b });
    console.log(`seeded brand ${b.code}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
