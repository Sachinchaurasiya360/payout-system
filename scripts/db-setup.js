/**
 * Applies the Prisma migration over the *pooled* connection (DATABASE_URL) and
 * records it in Prisma's `_prisma_migrations` table.
 *
 * Why not `prisma migrate deploy`? It requires a direct (non-pooled) connection
 * for its advisory lock. Some hosted Postgres setups (e.g. this Neon project)
 * only expose the pooled endpoint reliably, so `migrate` times out. This script
 * runs the exact same migration SQL over the pooled endpoint instead, and keeps
 * `prisma migrate status` consistent so `migrate deploy` stays a no-op later.
 *
 * Usage:
 *   node scripts/db-setup.js          # reset (DROP+CREATE schema) then apply + seed
 *   node scripts/db-setup.js --no-reset
 */
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { prisma, warmup } from '../src/db/prisma.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_NAME = '20260718000000_init';
const MIGRATION_SQL_PATH = path.join(__dirname, '..', 'prisma', 'migrations', MIGRATION_NAME, 'migration.sql');

const reset = !process.argv.includes('--no-reset');

/** Split a DDL script into individual statements (safe: no ';' inside literals here). */
function splitStatements(sql) {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    // drop chunks that are only comments/whitespace
    .filter((s) => s.split('\n').some((line) => line.trim() && !line.trim().startsWith('--')));
}

async function main() {
  process.stdout.write('Waking database... ');
  await warmup();
  console.log('ready');

  const sql = readFileSync(MIGRATION_SQL_PATH, 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  const statements = splitStatements(sql);

  console.log(`Migration: ${MIGRATION_NAME} (${statements.length} statements)`);

  if (reset) {
    console.log('Resetting schema (DROP SCHEMA public CASCADE; CREATE SCHEMA public)...');
    await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  }

  console.log('Applying migration...');
  for (const stmt of statements) {
    await prisma.$executeRawUnsafe(stmt);
  }

  // Prisma's bookkeeping table, so `migrate status`/`deploy` sees this as applied.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      id                  VARCHAR(36) PRIMARY KEY NOT NULL,
      checksum            VARCHAR(64) NOT NULL,
      finished_at         TIMESTAMPTZ,
      migration_name      VARCHAR(255) NOT NULL,
      logs                TEXT,
      rolled_back_at      TIMESTAMPTZ,
      started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_steps_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  const already = await prisma.$queryRawUnsafe(
    'SELECT 1 FROM "_prisma_migrations" WHERE migration_name = $1',
    MIGRATION_NAME,
  );
  if (already.length === 0) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "_prisma_migrations"
        (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
       VALUES ($1, $2, now(), $3, now(), 1)`,
      randomUUID(),
      checksum,
      MIGRATION_NAME,
    );
  }

  // Seed reference brands.
  const BRANDS = [
    { code: 'brand_1', name: 'Brand One' },
    { code: 'brand_2', name: 'Brand Two' },
    { code: 'brand_3', name: 'Brand Three' },
  ];
  for (const b of BRANDS) {
    await prisma.brand.upsert({ where: { code: b.code }, update: {}, create: b });
  }
  console.log(`Seeded ${BRANDS.length} brands.`);
  console.log('Database setup complete.');
}

main()
  .catch((err) => {
    console.error('db-setup failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
