// Phase 0.3 Multi-Tenant/Company/Branch Architecture - one-time backfill.
//
// NOT run as part of `prisma migrate deploy` and NOT run automatically by
// the application. Run manually, once, after the Phase 0.3 migration
// (20260917100806_phase0_3_multi_tenant_company_branch) has been applied to
// the target database.
//
// What it does: for every Tenant, ensures a default Company exists (named
// after the tenant's businessName, so an existing single-company tenant's
// new Company is immediately recognizable), then assigns every one of that
// tenant's Branches that has no companyId yet to it. Also backfills
// Warehouse.companyId from its own branch's companyId, where the warehouse
// has a branch (a central/company-wide warehouse with no branch is left
// with companyId null, matching the schema's design - see
// docs/phase0-3-migration-rollback-plan.md).
//
// Safe to run more than once: a tenant that already has a company (created
// by a prior run, or manually via the API) is not given a second default
// company - the "does this tenant have ANY company yet" check, plus only
// ever touching branches/warehouses with companyId still null, makes
// re-running a no-op wherever the first run already completed.
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
  console.log(`Phase 0.3 Company backfill - ${DRY_RUN ? 'DRY RUN (no writes will be made)' : 'LIVE RUN'}`);
  console.log(`Target database: ${maskDatabaseUrl(process.env.DATABASE_URL)}`);
  console.log('');

  const tenants = await prisma.tenant.findMany({ select: { id: true, businessName: true } });
  console.log(`Total tenants: ${tenants.length}`);

  let companiesCreated = 0;
  let companiesAlreadyPresent = 0;
  let branchesAssigned = 0;
  let warehousesAssigned = 0;
  const exceptions = [];

  for (const tenant of tenants) {
    try {
      let defaultCompany = await prisma.company.findFirst({ where: { tenantId: tenant.id } });

      if (!defaultCompany) {
        if (DRY_RUN) {
          console.log(`[dry-run] would create default company "${tenant.businessName}" for tenant ${tenant.id}`);
          companiesCreated++;
        } else {
          defaultCompany = await prisma.company.create({
            data: { tenantId: tenant.id, name: tenant.businessName, code: 'MAIN' },
          });
          companiesCreated++;
        }
      } else {
        companiesAlreadyPresent++;
      }

      const unassignedBranches = await prisma.branch.findMany({
        where: { tenantId: tenant.id, companyId: null },
        select: { id: true, name: true },
      });

      if (unassignedBranches.length > 0) {
        if (DRY_RUN) {
          console.log(`[dry-run] would assign ${unassignedBranches.length} branch(es) of tenant ${tenant.id} to its default company`);
          branchesAssigned += unassignedBranches.length;
        } else {
          const result = await prisma.branch.updateMany({
            where: { id: { in: unassignedBranches.map((b) => b.id) } },
            data: { companyId: defaultCompany.id },
          });
          branchesAssigned += result.count;
        }
      }

      // Warehouses: derive companyId from the warehouse's own branch, now
      // that every branch has one. A warehouse with no branch (a central/
      // company-wide one) is intentionally left with companyId null.
      const warehousesNeedingCompany = await prisma.warehouse.findMany({
        where: { tenantId: tenant.id, companyId: null, branchId: { not: null } },
        select: { id: true, branchId: true },
      });

      for (const wh of warehousesNeedingCompany) {
        const branch = await prisma.branch.findUnique({ where: { id: wh.branchId }, select: { companyId: true } });
        if (!branch?.companyId) continue;
        if (DRY_RUN) {
          console.log(`[dry-run] would assign warehouse ${wh.id} to company ${branch.companyId} (via its branch)`);
          warehousesAssigned++;
        } else {
          await prisma.warehouse.update({ where: { id: wh.id }, data: { companyId: branch.companyId } });
          warehousesAssigned++;
        }
      }
    } catch (err) {
      exceptions.push({ tenantId: tenant.id, businessName: tenant.businessName, error: err.message });
      console.error(`FAILED tenant ${tenant.id} (${tenant.businessName}):`, err.message);
    }
  }

  console.log('');
  console.log('--- Backfill summary ---');
  console.log(`Tenants processed: ${tenants.length}`);
  console.log(`Default companies created: ${companiesCreated}`);
  console.log(`Tenants that already had a company (untouched): ${companiesAlreadyPresent}`);
  console.log(`Branches assigned to a company: ${branchesAssigned}`);
  console.log(`Warehouses assigned to a company (via their branch): ${warehousesAssigned}`);
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
