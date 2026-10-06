// Branch-level authorization (Phase 6, extended in Phase 0.3 with a
// company-wide tier). TENANT_ADMIN/MANAGER are never restricted - "Managers
// may have branch-wide permissions" / "Tenant Admin/Owner may access all
// branches". Any other role IS restricted, but ONLY once they actually have
// a branch assigned (via User.branchId, UserBranchAccess, and/or, as of
// Phase 0.3, UserCompanyAccess): a staff member with no assignment at all
// keeps seeing tenant-wide data exactly as every role did before Phase 6 -
// so no pre-Phase-6 behavior or test changes for a tenant that never
// assigns branches/companies to its staff.
//
// Three access tiers for a restricted user, in addition to their own
// primary branch:
//   1. Own branch      - User.branchId
//   2. Selected branch - UserBranchAccess (Phase 6)
//   3. Company-wide     - UserCompanyAccess (Phase 0.3): grants every branch
//      under one Company, without needing a per-branch grant for each one.
const { ForbiddenError } = require('../utils/errors');

const UNRESTRICTED_ROLES = ['TENANT_ADMIN', 'MANAGER'];

// Returns null for "no restriction" (see caller sites), or the array of
// branch ids this user may act within.
async function getAccessibleBranchIds(prisma, user) {
  if (UNRESTRICTED_ROLES.includes(user.role)) return null;

  const [branchAccess, companyAccess] = await Promise.all([
    prisma.userBranchAccess.findMany({ where: { userId: user.id }, select: { branchId: true } }),
    prisma.userCompanyAccess.findMany({ where: { userId: user.id }, select: { companyId: true } }),
  ]);

  const ids = branchAccess.map((a) => a.branchId);
  if (user.branchId) ids.push(user.branchId);

  if (companyAccess.length > 0) {
    const companyIds = companyAccess.map((a) => a.companyId);
    const companyBranches = await prisma.branch.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } });
    ids.push(...companyBranches.map((b) => b.id));
  }

  if (ids.length === 0) return null;
  return [...new Set(ids)];
}

// Returns null for "no restriction", or the array of company ids this user
// has explicit company-wide access to (does NOT include companies reached
// only via an individual branch grant - this is specifically for
// company-level operations/authorization checks).
async function getAccessibleCompanyIds(prisma, user) {
  if (UNRESTRICTED_ROLES.includes(user.role)) return null;
  const access = await prisma.userCompanyAccess.findMany({ where: { userId: user.id }, select: { companyId: true } });
  if (access.length === 0) return null;
  return [...new Set(access.map((a) => a.companyId))];
}

// Throws 403 if a companyId isn't one this user has explicit company-wide
// access to. Used for company-level operations where branch-level access
// isn't the right granularity to check.
async function assertCompanyAccess(prisma, user, companyId) {
  if (!companyId) return;
  const ids = await getAccessibleCompanyIds(prisma, user);
  if (ids === null) return;
  if (!ids.includes(companyId)) throw new ForbiddenError('You do not have access to this company');
}

// Phase 0.4: warehouse-level access, the third assignable scope tier
// (UserWarehouseAccess). Two modes, chosen automatically per user:
//
//   - No explicit warehouse grants at all (the default, and the ONLY mode
//     any tenant used before this phase): warehouse access is simply
//     "every warehouse in a branch I can access" - identical to Phase 0.3
//     behavior, zero change for a tenant that never assigns warehouse
//     access.
//   - One or more explicit UserWarehouseAccess grants: the user is
//     restricted to EXACTLY those warehouses (fine-grained opt-in, e.g. a
//     STORE_KEEPER trusted with the sales floor but not the stockroom safe
//     within the same branch) - but a grant naming a warehouse whose branch
//     the user can no longer reach is never honored ("warehouse access must
//     respect Company and Branch authorization" - the spec's own words).
//
// Returns null for "no restriction" (TENANT_ADMIN/MANAGER only - the same
// unrestricted set as branch/company).
async function getAccessibleWarehouseIds(prisma, user) {
  if (UNRESTRICTED_ROLES.includes(user.role)) return null;

  const accessibleBranchIds = await getAccessibleBranchIds(prisma, user);

  const explicitGrants = await prisma.userWarehouseAccess.findMany({
    where: { userId: user.id },
    include: { warehouse: { select: { id: true, branchId: true } } },
  });

  if (explicitGrants.length > 0) {
    return explicitGrants
      .filter((g) => accessibleBranchIds === null || (g.warehouse.branchId && accessibleBranchIds.includes(g.warehouse.branchId)))
      .map((g) => g.warehouseId);
  }

  if (accessibleBranchIds === null) return null;
  const warehouses = await prisma.warehouse.findMany({ where: { branchId: { in: accessibleBranchIds } }, select: { id: true } });
  return warehouses.map((w) => w.id);
}

// A Prisma `where` fragment scoping a query by accessible warehouse ids -
// {} when unrestricted. Field defaults to `id` (for querying Warehouse
// itself); pass 'warehouseId' for a child table like InventoryTransaction.
async function warehouseScopeWhere(prisma, user, field = 'id') {
  const ids = await getAccessibleWarehouseIds(prisma, user);
  if (ids === null) return {};
  return { [field]: { in: ids } };
}

// Throws 403 if a warehouseId isn't one this user may act on.
async function assertWarehouseAccess(prisma, user, warehouseId) {
  if (!warehouseId) return;
  const ids = await getAccessibleWarehouseIds(prisma, user);
  if (ids === null) return;
  if (!ids.includes(warehouseId)) throw new ForbiddenError('You do not have access to this warehouse');
}

// A Prisma `where` fragment to spread into a query's filter - {} when the
// caller is unrestricted, so existing call sites are unaffected either way.
async function branchScopeWhere(prisma, user, field = 'branchId') {
  const ids = await getAccessibleBranchIds(prisma, user);
  if (ids === null) return {};
  return { [field]: { in: ids } };
}

// Throws 403 if a record's branchId isn't one this user may act on. A
// tenant-wide/unassigned record (branchId null) is never branch-restricted.
async function assertBranchAccess(prisma, user, branchId) {
  if (!branchId) return;
  const ids = await getAccessibleBranchIds(prisma, user);
  if (ids === null) return;
  if (!ids.includes(branchId)) throw new ForbiddenError('You do not have access to this branch');
}

module.exports = {
  getAccessibleBranchIds,
  branchScopeWhere,
  assertBranchAccess,
  getAccessibleCompanyIds,
  assertCompanyAccess,
  getAccessibleWarehouseIds,
  warehouseScopeWhere,
  assertWarehouseAccess,
};
