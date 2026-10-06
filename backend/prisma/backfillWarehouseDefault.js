// Phase 1.3 Branch & Warehouse Management - one-time backfill.
//
// NOT run as part of `prisma migrate deploy` and NOT run automatically by
// the application. Run manually, once, after the Phase 1.3 migration
// (20260919084337_phase1_3_branch_warehouse_management) has been applied to
// the target database.
//
// What it does: for every tenant that has at least one Warehouse but none of
// them marked isDefault yet (true for every tenant created before this
// phase, since the column previously didn't exist), marks that tenant's
// earliest-created warehouse as the default - i.e. it makes explicit, in the
// data, the same warehouse ensureDefaultWarehouse() would already have
// treated as the default via its "earliest created" fallback
// (warehouseStock.js). A tenant with zero warehouses is left untouched; one
// will be lazily created (and marked default) the first time
// ensureDefaultWarehouse() runs for it, same as before this phase. Mirrors
// backfillCompanyDefault.js's identical Phase 1.1 script exactly.
//
// Safe to run more than once: a tenant that already has an isDefault
// warehouse (from a prior run of this script, or set manually via the API)
// is skipped entirely.
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
  console.log(`Phase 1.3 Warehouse isDefault backfill - ${DRY_RUN ? 'DRY RUN (no writes will be made)' : 'LIVE RUN'}`);
  console.log(`Target database: ${maskDatabaseUrl(process.env.DATABASE_URL)}`);
  console.log('');

  const tenants = await prisma.tenant.findMany({ select: { id: true, businessName: true } });
  console.log(`Total tenants: ${tenants.length}`);

  let tenantsMarked = 0;
  let tenantsAlreadyHadDefault = 0;
  let tenantsWithNoWarehouse = 0;
  const exceptions = [];

  for (const tenant of tenants) {
    try {
      const alreadyDefault = await prisma.warehouse.findFirst({ where: { tenantId: tenant.id, isDefault: true } });
      if (alreadyDefault) {
        tenantsAlreadyHadDefault++;
        continue;
      }

      const earliest = await prisma.warehouse.findFirst({
        where: { tenantId: tenant.id },
        orderBy: { createdAt: 'asc' },
      });

      if (!earliest) {
        tenantsWithNoWarehouse++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`[dry-run] would mark warehouse ${earliest.id} ("${earliest.name}") as default for tenant ${tenant.id}`);
      } else {
        await prisma.warehouse.update({ where: { id: earliest.id }, data: { isDefault: true } });
      }
      tenantsMarked++;
    } catch (err) {
      exceptions.push({ tenantId: tenant.id, businessName: tenant.businessName, error: err.message });
      console.error(`FAILED tenant ${tenant.id} (${tenant.businessName}):`, err.message);
    }
  }

  console.log('');
  console.log('--- Backfill summary ---');
  console.log(`Tenants processed: ${tenants.length}`);
  console.log(`Tenants marked with a default warehouse: ${tenantsMarked}`);
  console.log(`Tenants that already had a default warehouse (untouched): ${tenantsAlreadyHadDefault}`);
  console.log(`Tenants with no warehouse yet (left for lazy creation): ${tenantsWithNoWarehouse}`);
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
