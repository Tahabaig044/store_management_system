// Owner Mobile (Android app) authentication - deliberately separate from the
// staff authenticate() middleware in src/middleware/auth.js, following the
// same isolation pattern already used for the Customer Portal
// (modules/portal/portalAuth.js). Mobile tokens carry `typ: 'mobile'` and are
// only ever accepted by routes mounted under /api/mobile - a staff web token
// can never reach a mobile route and a mobile token can never reach a
// staff/web route, even though both are signed with the same JWT secret and
// both resolve to the same User table.
//
// The Owner/Management mobile app is read-only until Phase 4.3 adds specific, reviewed actions. Access is
// restricted to MANAGEMENT roles (Phase 4.1: the business owner TENANT_ADMIN and the MANAGER role - the two
// roles the web app already treats as unrestricted management), and
// mobileReadOnlyGuard is a defensive backstop that rejects any non-GET
// request under /api/mobile at the API level - not merely by hiding buttons
// in the app - even if a future route were mistakenly added there.
const { verifyToken, isIssuedBeforePasswordChange } = require('../utils/jwt');
const { UnauthorizedError, ForbiddenError, ValidationError } = require('../utils/errors');
const prisma = require('../config/prisma');
const { requirePermission } = require('./permissions');
const { getAccessibleBranchIds, assertBranchAccess } = require('./branchScope');

// Which roles may hold a mobile session at all. Everything else (cashier, store keeper, ...) is refused at login
// with the same message as a wrong password. What a permitted role may DO is not decided here: every mobile route
// still passes through the existing permission catalog (requireMobilePermission) and branch scope.
const MOBILE_ROLES = ['TENANT_ADMIN', 'MANAGER'];
const isMobileRole = (role) => MOBILE_ROLES.includes(role);

async function authenticateMobile(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new UnauthorizedError('Missing or invalid authorization header');
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    throw new UnauthorizedError('Invalid or expired token');
  }
  if (payload.typ !== 'mobile') {
    throw new UnauthorizedError('Invalid or expired token');
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user || !user.isActive || !isMobileRole(user.role) || !user.tenantId) {
    throw new UnauthorizedError('Account is inactive or no longer eligible for Owner Mobile access');
  }
  if (isIssuedBeforePasswordChange(payload, user)) {
    throw new UnauthorizedError('Invalid or expired token');
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId } });
  if (!tenant || !tenant.isActive) {
    throw new ForbiddenError('Tenant account is inactive');
  }

  req.user = {
    id: user.id,
    tenantId: user.tenantId,
    role: user.role,
    branchId: user.branchId,
    name: user.name,
    email: user.email,
    mobile: true,
  };
  next();
}

function mobileReadOnlyGuard(req, res, next) {
  if (req.method !== 'GET') {
    throw new ForbiddenError('The Owner Mobile app is read-only; this action is not permitted');
  }
  next();
}

// Route guard: the same permission check the web API uses, evaluated for the mobile session's real role.
const requireMobilePermission = (resource, action) => requirePermission(resource, action);

// The branch context of a session: null branchIds = unrestricted (every branch of the tenant).
async function branchContext(user) {
  const ids = await getAccessibleBranchIds(prisma, user);
  return { restricted: ids !== null, branchIds: ids };
}

// A branchId supplied by the client must be one of this tenant's branches AND one the user may access.
async function assertMobileBranch(user, branchId) {
  if (!branchId) return;
  const branch = await prisma.branch.findFirst({ where: { id: branchId, tenantId: user.tenantId } });
  if (!branch) throw new ValidationError('branchId does not belong to this tenant');
  await assertBranchAccess(prisma, user, branchId);
}

module.exports = { authenticateMobile, mobileReadOnlyGuard, MOBILE_ROLES, isMobileRole, requireMobilePermission, branchContext, assertMobileBranch };
