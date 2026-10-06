// Phase 0.4: centralized, permission-based authorization - the "what can
// the user do" half of the authorization model (the "where" half is
// branchScope.js's Branch/Company/Warehouse scoping, used alongside this,
// never instead of it).
//
// Deliberately NOT a wholesale replacement of every existing requireRole()
// call in this codebase - see docs/phase0-4-authorization-architecture.md
// for the explicit, disclosed scope decision. Wired into the modules this
// phase actually migrates (Products, Warehouses, Sale-reversal); every
// other resource's role-group behavior remains centralized via
// constants/roles.js exactly as before, and is ALSO now fully documented in
// the Permission/RolePermission catalog (seeded from
// constants/permissionCatalog.js) even where the code hasn't been rewired
// to enforce through it yet - so the migration mapping the spec asks for
// (§7) is complete even where the code migration is intentionally staged.
const prisma = require('../config/prisma');
const { ForbiddenError } = require('../utils/errors');

// In-process cache of the full RolePermission grant set, since this data
// changes essentially never at runtime (only via the seed script) and is
// looked up on every single protected request otherwise. Keyed by
// "ROLE:RESOURCE:ACTION" -> boolean. Cleared automatically after 5 minutes
// so a re-seed (e.g. extending the catalog) is picked up without a restart.
let cache = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function loadGrants() {
  if (cache && Date.now() - cacheLoadedAt < CACHE_TTL_MS) return cache;
  const rows = await prisma.rolePermission.findMany({ include: { permission: true } });
  const grants = new Set(rows.map((r) => `${r.role}:${r.permission.resource}:${r.permission.action}`));
  cache = grants;
  cacheLoadedAt = Date.now();
  return grants;
}

async function hasPermission(role, resource, action) {
  const grants = await loadGrants();
  return grants.has(`${role}:${resource}:${action}`);
}

// Returns the full list of "RESOURCE:ACTION" keys a role holds - used to
// expose "effective permissions" to the frontend (see auth.controller.js's
// /me and login responses) so the UI can hide unauthorized actions without
// hardcoding role names.
async function effectivePermissionsForRole(role) {
  const grants = await loadGrants();
  return [...grants].filter((g) => g.startsWith(`${role}:`)).map((g) => g.split(':').slice(1).join(':'));
}

function requirePermission(resource, action) {
  return async (req, res, next) => {
    const allowed = await hasPermission(req.user.role, resource, action);
    if (!allowed) {
      throw new ForbiddenError(`You do not have permission to ${action.toLowerCase()} ${resource.toLowerCase().replace(/_/g, ' ')}`);
    }
    next();
  };
}

module.exports = { requirePermission, hasPermission, effectivePermissionsForRole };
