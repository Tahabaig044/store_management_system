// Phase 0.2 Universal Product Architecture - one-time legacy data backfill.
//
// NOT run as part of `prisma migrate deploy` and NOT run automatically by
// the application. Run manually, once, after the Phase 0.2 migration
// (20260917120000_phase0_2_universal_product_architecture) has been applied
// to the target database - see docs/phase0-2-backfill-implementation-report.md.
//
// What it does: for every existing Product whose legacy `type` is FRAME,
// LENS, or MEDICINE, creates (or re-syncs) the matching
// ProductOpticalAttributes / ProductMedicineAttributes extension row, using
// the exact same mapping function (`syncExtensionsFromLegacyFields`) the
// live create/update routes already use - so backfilled data is guaranteed
// consistent with what a fresh create would produce. GENERAL products need
// no extension and are correctly skipped (not an omission).
//
// Safe to run more than once: every write is an upsert keyed on the
// product's own id (a DB-level unique constraint on both extension tables),
// so re-running this script re-applies the same values rather than ever
// creating a duplicate row - this is enforced at the schema level, not just
// by this script's own logic.
//
// Never modifies, deletes, or overwrites any legacy Product column - it only
// ever reads them and writes to the new extension tables.
//
// Usage:
//   DATABASE_URL="<test-db-url>" node prisma/backfillProductExtensions.js --dry-run
//   DATABASE_URL="<test-db-url>" node prisma/backfillProductExtensions.js
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { syncExtensionsFromLegacyFields } = require('../src/modules/products/productService');

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

function maskDatabaseUrl(url) {
  if (!url) return '(none)';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}:${u.port || '(default)'}${u.pathname}`;
  } catch {
    return '(unparseable)';
  }
}

async function main() {
  console.log(`Phase 0.2 Product extension backfill - ${DRY_RUN ? 'DRY RUN (no writes will be made)' : 'LIVE RUN'}`);
  console.log(`Target database: ${maskDatabaseUrl(process.env.DATABASE_URL)}`);
  console.log('');

  const totalProducts = await prisma.product.count();
  const products = await prisma.product.findMany({
    where: { type: { in: ['FRAME', 'LENS', 'MEDICINE'] } },
    select: {
      id: true,
      tenantId: true,
      type: true,
      name: true,
      frameBrand: true,
      frameModel: true,
      frameColor: true,
      frameSize: true,
      lensType: true,
      lensMaterial: true,
      lensCoating: true,
      batchNumber: true,
      expiryDate: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Total products in database: ${totalProducts}`);
  console.log(`Products with an industry-specific legacy type (FRAME/LENS/MEDICINE): ${products.length}`);
  console.log(`Products with type GENERAL (no extension needed, correctly skipped): ${totalProducts - products.length}`);
  console.log('');

  let created = 0;
  let reSynced = 0;
  const exceptions = [];

  for (const product of products) {
    try {
      const existingExtension =
        product.type === 'MEDICINE'
          ? await prisma.productMedicineAttributes.findUnique({ where: { productId: product.id } })
          : await prisma.productOpticalAttributes.findUnique({ where: { productId: product.id } });

      if (DRY_RUN) {
        console.log(`[dry-run] would ${existingExtension ? 're-sync' : 'create'} extension for product ${product.id} (${product.type}) "${product.name}"`);
        if (existingExtension) reSynced++;
        else created++;
        continue;
      }

      await prisma.$transaction(async (tx) => {
        await syncExtensionsFromLegacyFields(tx, {
          tenantId: product.tenantId,
          productId: product.id,
          type: product.type,
          frameBrand: product.frameBrand,
          frameModel: product.frameModel,
          frameColor: product.frameColor,
          frameSize: product.frameSize,
          lensType: product.lensType,
          lensMaterial: product.lensMaterial,
          lensCoating: product.lensCoating,
          batchNumber: product.batchNumber,
          expiryDate: product.expiryDate,
        });
      });

      if (existingExtension) reSynced++;
      else created++;
    } catch (err) {
      exceptions.push({ productId: product.id, tenantId: product.tenantId, type: product.type, name: product.name, error: err.message });
      console.error(`FAILED product ${product.id} (${product.type}) "${product.name}":`, err.message);
    }
  }

  console.log('');
  console.log('--- Backfill summary ---');
  console.log(`Total legacy-typed products found: ${products.length}`);
  console.log(`Extension rows newly created: ${created}`);
  console.log(`Extension rows already present (re-synced to current legacy field values): ${reSynced}`);
  console.log(`Exceptions: ${exceptions.length}`);
  if (exceptions.length) {
    console.log(JSON.stringify(exceptions, null, 2));
  }
  console.log(DRY_RUN ? '\nDry run complete - no writes were made.' : '\nBackfill complete.');

  await prisma.$disconnect();
  if (exceptions.length > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error('Backfill script crashed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
