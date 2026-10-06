// Owner Mobile (Android app) API - Phase 1 foundation.
//
// This is a deliberately separate, versioned surface (/api/mobile/v1) from
// the main web API, following the same "distinct identity, own middleware"
// pattern already used for the Customer Portal (see modules/portal/). It
// exists so the Android client can evolve (versioned) without ever touching
// or risking the existing web application's routes/contracts, and so that
// read-only enforcement can be guaranteed at the API level rather than
// relying on the app simply not showing write buttons.
//
// Only a tenant's management roles (TENANT_ADMIN, MANAGER) may obtain a mobile
// token - see authenticateMobile / this file's login handler. No write
// endpoints are defined here, and mobileReadOnlyGuard rejects any non-GET
// request under this router as a defensive backstop for future additions.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { verifyPassword } = require('../../utils/password');
const { signMobileToken } = require('../../utils/jwt');
const { UnauthorizedError, ValidationError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { authenticateMobile, mobileReadOnlyGuard, isMobileRole, branchContext } = require('../../middleware/mobileAuth');
const { effectivePermissionsForRole } = require('../../middleware/permissions');

const router = express.Router();

// Public: lets the app confirm connectivity/reachability before showing the
// login screen (e.g. on launch, or after a network error) without requiring
// a valid session. Mirrors /api/health but versioned for the mobile client.
router.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), api: 'mobile', version: 'v1' });
});

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

// What this session may do and where: the user's real role, the permission keys the web app would grant that role
// (the same catalog - the app hides what it cannot do, the API still refuses it), and the branch scope.
async function buildAccess(user) {
  const [permissions, ctx] = await Promise.all([effectivePermissionsForRole(user.role), branchContext(user)]);
  return { role: user.role, permissions, branchRestricted: ctx.restricted, branchIds: ctx.branchIds };
}

router.post('/auth/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid login data', parsed.error.flatten());
  const { email, password } = parsed.data;

  const user = await prisma.user.findFirst({ where: { email: email.toLowerCase() } });
  if (!user || !user.isActive) throw new UnauthorizedError('Invalid email or password');

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) throw new UnauthorizedError('Invalid email or password');

  // Deliberately checked *after* verifying the password, so a wrong-role
  // account and a wrong-password attempt both look identical to a caller
  // probing for valid emails - the fixed 'Invalid email or password' message
  // never confirms an account exists just because it isn't a management role.
  if (!isMobileRole(user.role) || !user.tenantId) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId } });
  if (!tenant || !tenant.isActive) throw new UnauthorizedError('Invalid email or password');

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const token = signMobileToken(user);
  req.user = { id: user.id, tenantId: user.tenantId, role: user.role };
  await logAudit({ req, action: 'MOBILE_LOGIN', entity: 'User', entityId: user.id, metadata: { app: 'owner-mobile' } });

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    tenant: {
      id: tenant.id,
      name: tenant.name,
      businessName: tenant.businessName,
      currency: tenant.currency,
      timezone: tenant.timezone,
    },
    permissions: { readOnly: true, role: 'OWNER_MOBILE' },
    access: await buildAccess(user),
  });
});

// Everything below requires a valid Owner Mobile token.
router.use(authenticateMobile);

router.post('/auth/logout', async (req, res) => {
  // JWTs are stateless in this app (no server-side session store, same as
  // the web API) - "logout" is the client discarding its token locally.
  // This endpoint exists so the app has a real network call to make on
  // logout and so the action lands in the tenant's audit trail.
  await logAudit({ req, action: 'MOBILE_LOGOUT', entity: 'User', entityId: req.user.id });
  res.json({ message: 'Logged out' });
});

// Everything below this point must be a read (GET) - see mobileReadOnlyGuard.
router.use(mobileReadOnlyGuard);

router.get('/profile', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { tenant: true, branch: true },
  });
  if (!user) throw new UnauthorizedError('Account is inactive or no longer exists');

  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      lastLoginAt: user.lastLoginAt,
    },
    tenant: {
      id: user.tenant.id,
      name: user.tenant.name,
      businessName: user.tenant.businessName,
      logoUrl: user.tenant.logoUrl,
      currency: user.tenant.currency,
      timezone: user.tenant.timezone,
    },
    branch: user.branch ? { id: user.branch.id, name: user.branch.name } : null,
    permissions: { readOnly: true, role: 'OWNER_MOBILE', writesAllowed: [] },
    access: await buildAccess(user),
  });
});

// The company/branch context this session works within: the branches (grouped by company) the user may access.
// Unrestricted roles see every active branch of the tenant; a restricted user only their own scope.
router.get('/context', async (req, res) => {
  const ctx = await branchContext(req.user);
  const branches = await prisma.branch.findMany({
    where: { tenantId: req.user.tenantId, isActive: true, ...(ctx.restricted ? { id: { in: ctx.branchIds } } : {}) },
    select: { id: true, name: true, code: true, companyId: true },
    orderBy: { name: 'asc' },
  });
  const companyIds = [...new Set(branches.map((b) => b.companyId).filter(Boolean))];
  const companies = companyIds.length
    ? await prisma.company.findMany({ where: { tenantId: req.user.tenantId, id: { in: companyIds } }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
    : [];
  res.json({
    branchRestricted: ctx.restricted,
    companies,
    branches,
    // A restricted user with exactly one branch is simply working in it; otherwise the person chooses.
    defaultBranchId: ctx.restricted && branches.length === 1 ? branches[0].id : null,
  });
});

module.exports = router;
