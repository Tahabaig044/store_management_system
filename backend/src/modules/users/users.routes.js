const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { TENANT_ADMIN_ONLY } = require('../../constants/roles');
const { hashPassword, passwordSchema, generateResetToken, hashResetToken } = require('../../utils/password');
const { ValidationError, NotFoundError, ForbiddenError, ConflictError } = require('../../utils/errors');
const { resetLink } = require('../auth/auth.controller');
const { logAudit } = require('../../middleware/audit');

async function assertBranchBelongsToTenant(tenantId, branchId) {
  if (!branchId) return;
  const branch = await prisma.branch.findFirst({ where: { id: branchId, tenantId } });
  if (!branch) throw new NotFoundError('Branch not found');
}

const ROLE_VALUES = ['TENANT_ADMIN', 'MANAGER', 'CASHIER', 'STORE_KEEPER', 'RECEPTIONIST', 'ACCOUNTANT', 'DOCTOR'];

const createSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: passwordSchema,
  role: z.enum(ROLE_VALUES),
  branchId: z.string().uuid().optional(),
});

const updateSchema = z.object({
  name: z.string().min(2).optional(),
  role: z.enum(ROLE_VALUES).optional(),
  branchId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional(),
  password: passwordSchema.optional(),
});

function sanitize(user) {
  const { passwordHash, ...rest } = user;
  return rest;
}

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('USER', 'VIEW'), async (req, res) => {
  const users = await prisma.user.findMany({
    where: { tenantId: req.user.tenantId },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ items: users.map(sanitize) });
});

router.post('/', requirePermission('USER', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid user data', parsed.error.flatten());
  const { name, email, password, role, branchId } = parsed.data;
  await assertBranchBelongsToTenant(req.user.tenantId, branchId);

  // Email is the login identity (login has no tenant field), so it must be unique across the platform.
  if (await prisma.user.findFirst({ where: { email: email.toLowerCase() }, select: { id: true } })) {
    throw new ConflictError('An account with this email already exists');
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { tenantId: req.user.tenantId, name, email: email.toLowerCase(), passwordHash, role, branchId },
  });
  await logAudit({ req, action: 'USER_CREATE', entity: 'User', entityId: user.id, metadata: { role, branchId } });
  res.status(201).json({ item: sanitize(user) });
});

router.patch('/:id', requirePermission('USER', 'UPDATE'), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid user data', parsed.error.flatten());

  const existing = await prisma.user.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
  });
  if (!existing) throw new NotFoundError();
  if (existing.id === req.user.id && parsed.data.isActive === false) {
    throw new ForbiddenError('You cannot deactivate your own account');
  }
  // Phase 0.4: structural privilege-escalation guard. Role changes are
  // already TENANT_ADMIN-only (router-level gate above), so this isn't
  // closing a live escalation path today - it's a belt-and-suspenders
  // guarantee that "users cannot elevate their own privileges" holds even
  // if that gate were ever loosened, and prevents an accidental/careless
  // self-role-change (e.g. a distracted admin editing their own row).
  if (existing.id === req.user.id && parsed.data.role && parsed.data.role !== existing.role) {
    throw new ForbiddenError('You cannot change your own role');
  }
  await assertBranchBelongsToTenant(req.user.tenantId, parsed.data.branchId);

  const { password, ...rest } = parsed.data;
  const data = { ...rest };
  if (password) {
    data.passwordHash = await hashPassword(password);
    // Signs the user out everywhere (tokens issued before this instant are refused).
    data.passwordChangedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  }

  const user = await prisma.user.update({ where: { id: existing.id }, data });
  // Field names only (never the password itself) - passwordChanged is a
  // boolean flag so a reset is visible in the trail without leaking anything.
  await logAudit({ req, action: 'USER_UPDATE', entity: 'User', entityId: user.id, metadata: { changedFields: Object.keys(rest), passwordChanged: Boolean(password) } });
  res.json({ item: sanitize(user) });
});

// A tenant admin issues a one-time reset link for a user of their own tenant (works with no email provider:
// the admin hands the link over). The link is shown once and only its hash is stored; it expires in 24 hours.
router.post('/:id/reset-link', requireRole(...TENANT_ADMIN_ONLY), async (req, res) => {
  const user = await prisma.user.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!user) throw new NotFoundError();
  const token = generateResetToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash: hashResetToken(token), expiresAt, createdById: req.user.id },
  });
  await logAudit({ req, action: 'USER_RESET_LINK_ISSUED', entity: 'User', entityId: user.id });
  res.status(201).json({ link: resetLink(token), expiresAt });
});

// Phase 1.2: a user-centric view of the three existing access-grant tiers
// (UserCompanyAccess/Phase 0.3, UserBranchAccess/Phase 6,
// UserWarehouseAccess/Phase 0.4), which until now could only be inspected
// resource-by-resource via GET /companies/:id/access, /branches/:id/access,
// and /warehouses/:id/access. Read-only: granting/revoking still goes
// through those same three existing endpoints (POST/DELETE .../:id/access) -
// this adds no new write path and no new authorization rule, only a
// convenience aggregation for the User Management screen. TENANT_ADMIN-only,
// matching every other access-grant endpoint in this codebase.
router.get('/:id/access', requireRole(...TENANT_ADMIN_ONLY), async (req, res) => {
  const user = await prisma.user.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!user) throw new NotFoundError();

  const [companyAccess, branchAccess, warehouseAccess] = await Promise.all([
    prisma.userCompanyAccess.findMany({ where: { userId: user.id }, include: { company: { select: { id: true, name: true } } } }),
    prisma.userBranchAccess.findMany({ where: { userId: user.id }, include: { branch: { select: { id: true, name: true } } } }),
    prisma.userWarehouseAccess.findMany({ where: { userId: user.id }, include: { warehouse: { select: { id: true, name: true } } } }),
  ]);

  res.json({
    userId: user.id,
    primaryBranchId: user.branchId,
    companyAccess: companyAccess.map((a) => ({ companyId: a.companyId, name: a.company.name })),
    branchAccess: branchAccess.map((a) => ({ branchId: a.branchId, name: a.branch.name })),
    warehouseAccess: warehouseAccess.map((a) => ({ warehouseId: a.warehouseId, name: a.warehouse.name })),
  });
});

module.exports = router;
