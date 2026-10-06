const { verifyToken, isIssuedBeforePasswordChange } = require('../utils/jwt');
const { UnauthorizedError, ForbiddenError } = require('../utils/errors');
const prisma = require('../config/prisma');
const { isMobileAllowed } = require('./mobileGateway');
const { isMobileRole } = require('./mobileAuth');

// Verifies the JWT and attaches req.user = { id, tenantId, role }.
// Re-checks the user record so a deactivated user/tenant loses access immediately,
// not only after their token expires.
async function authenticate(req, res, next) {
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
  // Portal (typ: 'portal') and Owner Mobile (typ: 'mobile') tokens are
  // distinct identities with their own middleware (portalAuth.js,
  // mobileAuth.js) and must never be usable against staff web routes.
  // A staff token never carries a `typ` claim, so any typed token is rejected
  // here regardless of which non-staff surface it belongs to.
  // The ONE exception (Phase 4.3): a management mobile token may reach the exact endpoints listed in
  // mobileGateway.js (existing routes, existing rules). Any other typed token, or a mobile token anywhere else,
  // is refused exactly as before.
  const viaMobile = payload.typ === 'mobile';
  if (payload.typ && !(viaMobile && isMobileAllowed(req.method, req.originalUrl))) {
    throw new UnauthorizedError('Invalid or expired token');
  }

  // One round trip for the user and its tenant (this runs on every authenticated request).
  const user = await prisma.user.findUnique({ where: { id: payload.sub }, include: { tenant: true } });
  if (!user || !user.isActive) {
    throw new UnauthorizedError('Account is inactive or no longer exists');
  }
  if (isIssuedBeforePasswordChange(payload, user)) {
    throw new UnauthorizedError('Invalid or expired token');
  }
  // A mobile session belongs to a management role, re-checked on every request (a demoted user loses it at once).
  if (viaMobile && (!isMobileRole(user.role) || !user.tenantId)) {
    throw new UnauthorizedError('Account is inactive or no longer eligible for Owner Mobile access');
  }
  if (user.tenantId) {
    const tenant = user.tenant;
    if (!tenant || !tenant.isActive) {
      throw new ForbiddenError('Tenant account is inactive');
    }
    // Phase 0.5: this tenant row was already fetched to check isActive above -
    // attaching the fields requireModule() needs (see middleware/moduleAccess.js)
    // is free (no extra query) and mirrors the existing req.user convention.
    req.tenant = { id: tenant.id, enabledIndustryPacks: tenant.enabledIndustryPacks };
  }

  req.user = {
    id: user.id,
    tenantId: user.tenantId,
    role: user.role,
    branchId: user.branchId,
    name: user.name,
    email: user.email,
    ...(viaMobile && { mobile: true }),
  };
  next();
}

// Requires a tenant-scoped user (blocks platform-only SUPER_ADMIN users from
// tenant business endpoints unless they've been given a tenantId).
function requireTenant(req, res, next) {
  if (!req.user.tenantId) {
    throw new ForbiddenError('This action requires an active tenant context');
  }
  next();
}

// Role-based access control. Server-side only - never trust a client-supplied role.
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.user.role)) {
      throw new ForbiddenError('You do not have permission to perform this action');
    }
    next();
  };
}

module.exports = { authenticate, requireTenant, requireRole };
