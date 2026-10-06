// Phase 1.3 Branch & Warehouse Management - one-time backfill.
//
// NOT run as part of `prisma migrate deploy` and NOT run automatically by
// the application. Safe to run at any time, against any environment.
//
// What it fixes: Warehouse.companyId is a derived convenience field
// (schema.prisma's comment on Warehouse) meant to be populated from the
// warehouse's own branch's company. The Phase 0.3 migration's one-time
// backfillCompanies.js script correctly populated it for every warehouse
// that existed AT THAT TIME - but POST /api/warehouses itself never set
// companyId on newly-created warehouses from Phase 0.3 onward, so any
// warehouse created via the API between Phase 0.3 and this Phase 1.3 fix
// still has companyId: null even though it has a branchId. This script
// closes that gap for existing data; the route itself is now fixed
// (warehouses.routes.js) so no new warehouse will need this going forward.
//
// Safe to run more than once: only touches warehouses that currently have a
// branchId but a null companyId, and only when that branch itself has a
// companyId to give it.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

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
  console.log(`Phase 1.3 Warehouse companyId backfill - ${DRY_RUN ? 'DRY RUN (no writes will be made)' : 'LIVE RUN'}`);
  console.log(`Target database: ${maskDatabaseUrl(process.env.DATABASE_URL)}`);
  console.log('');

  const warehouses = await prisma.warehouse.findMany({
    where: { companyId: null, branchId: { not: null } },
    select: { id: true, name: true, branchId: true },
  });
  console.log(`Warehouses with a branch but no companyId: ${warehouses.length}`);

  let updated = 0;
  let skippedNoBranchCompany = 0;
  const exceptions = [];

  for (const wh of warehouses) {
    try {
      const branch = await prisma.branch.findUnique({ where: { id: wh.branchId }, select: { companyId: true } });
      if (!branch?.companyId) {
        skippedNoBranchCompany++;
        continue;
      }
      if (DRY_RUN) {
        console.log(`[dry-run] would set warehouse ${wh.id} ("${wh.name}") companyId to ${branch.companyId}`);
      } else {
        await prisma.warehouse.update({ where: { id: wh.id }, data: { companyId: branch.companyId } });
      }
      updated++;
    } catch (err) {
      exceptions.push({ warehouseId: wh.id, name: wh.name, error: err.message });
      console.error(`FAILED warehouse ${wh.id} (${wh.name}):`, err.message);
    }
  }

  console.log('');
  console.log('--- Backfill summary ---');
  console.log(`Warehouses processed: ${warehouses.length}`);
  console.log(`Warehouses updated with a companyId: ${updated}`);
  console.log(`Skipped (branch itself has no companyId): ${skippedNoBranchCompany}`);
  console.log(`Exceptions: ${exceptions.length}`);
  if (exceptions.length) console.log(JSON.stringify(exceptions, null, 2));
  console.log(DRY_RUN ? '\nDry run complete - no writes were made.' : '\nBackfill complete.');

  await prisma.$disconnect();
  if (exceptions.length > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error('Backfill script crashed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
