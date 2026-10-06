// Phase 1.1 Company & Tenant Management - one-time backfill.
//
// NOT run as part of `prisma migrate deploy` and NOT run automatically by
// the application. Run manually, once, after the Phase 1.1 migration
// (20260919064158_phase1_1_company_tenant_management) has been applied to
// the target database.
//
// What it does: for every tenant that has at least one Company but none of
// them marked isDefault yet (true for every tenant created before this
// phase, since the column previously didn't exist), marks that tenant's
// earliest-created company as the default - i.e. it makes explicit, in the
// data, the same company ensureDefaultCompany() would already have treated
// as the default via its "earliest created" fallback (companyService.js).
// A tenant with zero companies is left untouched; one will be lazily
// created (and marked default) the first time ensureDefaultCompany() runs
// for it, same as before this phase.
//
// Safe to run more than once: a tenant that already has an isDefault
// company (from a prior run of this script, or set manually via the API)
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
  console.log(`Phase 1.1 Company isDefault backfill - ${DRY_RUN ? 'DRY RUN (no writes will be made)' : 'LIVE RUN'}`);
  console.log(`Target database: ${maskDatabaseUrl(process.env.DATABASE_URL)}`);
  console.log('');

  const tenants = await prisma.tenant.findMany({ select: { id: true, businessName: true } });
  console.log(`Total tenants: ${tenants.length}`);

  let tenantsMarked = 0;
  let tenantsAlreadyHadDefault = 0;
  let tenantsWithNoCompany = 0;
  const exceptions = [];

  for (const tenant of tenants) {
    try {
      const alreadyDefault = await prisma.company.findFirst({ where: { tenantId: tenant.id, isDefault: true } });
      if (alreadyDefault) {
        tenantsAlreadyHadDefault++;
        continue;
      }

      const earliest = await prisma.company.findFirst({
        where: { tenantId: tenant.id },
        orderBy: { createdAt: 'asc' },
      });

      if (!earliest) {
        tenantsWithNoCompany++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`[dry-run] would mark company ${earliest.id} ("${earliest.name}") as default for tenant ${tenant.id}`);
      } else {
        await prisma.company.update({ where: { id: earliest.id }, data: { isDefault: true } });
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
  console.log(`Tenants marked with a default company: ${tenantsMarked}`);
  console.log(`Tenants that already had a default company (untouched): ${tenantsAlreadyHadDefault}`);
  console.log(`Tenants with no company yet (left for lazy creation): ${tenantsWithNoCompany}`);
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
