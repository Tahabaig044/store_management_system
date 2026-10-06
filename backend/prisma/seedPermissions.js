// Phase 0.4 - one-time (but safely repeatable) seed of the global Permission
// / RolePermission catalog from src/constants/permissionCatalog.js. This is
// reference/config data, not per-tenant data, so unlike the Phase 0.2/0.3
// backfill scripts this one has nothing to do with existing tenant rows -
// it just needs to run once per environment (including production) after
// the Phase 0.4 migration is applied, before requirePermission() has
// anything to check against.
//
// Safe to run more than once: every write is an upsert keyed on the
// Permission's unique (resource, action) pair, or the RolePermission's
// unique (role, permissionId) pair - re-running never creates duplicates,
// and additively adding a new entry to permissionCatalog.js and re-running
// this script is the intended way to extend the catalog later.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PERMISSION_CATALOG } = require('../src/constants/permissionCatalog');

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`Phase 0.4 Permission catalog seed - ${DRY_RUN ? 'DRY RUN (no writes will be made)' : 'LIVE RUN'}`);

  let permissionsUpserted = 0;
  let rolePermissionsUpserted = 0;

  for (const { resource, actions } of PERMISSION_CATALOG) {
    for (const { action, roles } of actions) {
      const key = `${resource}:${action}`;
      if (DRY_RUN) {
        console.log(`[dry-run] would ensure permission ${key} exists, granted to: ${roles.join(', ')}`);
        permissionsUpserted++;
        rolePermissionsUpserted += roles.length;
        continue;
      }

      const permission = await prisma.permission.upsert({
        where: { resource_action: { resource, action } },
        create: { resource, action, key },
        update: { key },
      });
      permissionsUpserted++;

      for (const role of roles) {
        await prisma.rolePermission.upsert({
          where: { role_permissionId: { role, permissionId: permission.id } },
          create: { role, permissionId: permission.id },
          update: {},
        });
        rolePermissionsUpserted++;
      }
    }
  }

  console.log('');
  console.log('--- Seed summary ---');
  console.log(`Permissions ensured: ${permissionsUpserted}`);
  console.log(`Role-permission grants ensured: ${rolePermissionsUpserted}`);
  console.log(DRY_RUN ? '\nDry run complete - no writes were made.' : '\nSeed complete.');

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Permission seed script crashed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
