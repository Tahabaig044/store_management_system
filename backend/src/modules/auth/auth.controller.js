const crypto = require('crypto');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { hashPassword, verifyPassword, passwordSchema, generateResetToken, hashResetToken, verifyAgainstDummy } = require('../../utils/password');
const { signToken } = require('../../utils/jwt');
const { UnauthorizedError, ValidationError, ForbiddenError, ConflictError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { effectivePermissionsForRole } = require('../../middleware/permissions');
const mailer = require('../../utils/mailer');
const whatsapp = require('../communication/providers/provider');
const push = require('../push/providers/provider');
const { captureException } = require('../../utils/errorTracking');
const { corsOrigins } = require('../../config/env');

const registerTenantSchema = z.object({
  businessName: z.string().min(2),
  adminName: z.string().min(2),
  email: z.string().email(),
  password: passwordSchema,
  phone: z.string().optional(),
  inviteCode: z.string().optional(),
});

// Who may create a new business account. Intentional, and fail-closed in production:
//   SIGNUP_INVITE_CODE set     -> registration requires that code ("invite")
//   else SIGNUP_OPEN=true      -> anyone may register ("open")
//   else in production         -> registration is disabled ("closed")
//   else (development / tests) -> "open"
// Read at call time, so it follows the environment and can be tested.
function signupMode() {
  if (process.env.SIGNUP_INVITE_CODE) return 'invite';
  if (process.env.SIGNUP_OPEN === 'true') return 'open';
  return process.env.NODE_ENV === 'production' ? 'closed' : 'open';
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const RESET_TTL_MS = 60 * 60 * 1000;
const appUrl = () => (process.env.APP_URL || corsOrigins[0] || '').replace(/\/$/, '');
const resetLink = (token) => `${appUrl()}/reset-password?token=${encodeURIComponent(token)}`;

// What the login / register / forgot-password screens need in order to be honest about what works here.
function publicConfig(req, res) {
  // Which features can actually deliver anything on this installation (see utils/providerPolicy.js).
  res.json({
    signupMode: signupMode(),
    passwordResetByEmail: mailer.isConfigured(),
    whatsappAvailable: whatsapp.isDeliveryAvailable('mock'),
    portalLoginAvailable: whatsapp.isDeliveryAvailable('mock'),
    pushAvailable: push.isDeliveryAvailable('mock'),
  });
}

async function registerTenant(req, res) {
  const parsed = registerTenantSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid registration data', parsed.error.flatten());
  const { businessName, adminName, email, password, phone, inviteCode } = parsed.data;

  const mode = signupMode();
  if (mode === 'closed') throw new ForbiddenError('Registration is by invitation only. Contact the service provider.');
  if (mode === 'invite' && !(inviteCode && safeEqual(inviteCode, process.env.SIGNUP_INVITE_CODE))) {
    throw new ForbiddenError('A valid invitation code is required to register.');
  }
  // Email is the login identity and login has no tenant field, so it must be unique across the platform.
  if (await prisma.user.findFirst({ where: { email: email.toLowerCase() }, select: { id: true } })) {
    throw new ConflictError('An account with this email already exists');
  }

  const passwordHash = await hashPassword(password);

  const result = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        name: businessName,
        businessName,
        phone,
        subscription: { create: { plan: 'trial', status: 'TRIAL' } },
      },
    });

    // Phase 0.3: every tenant gets a default Company from day one, so a
    // brand-new tenant is never in the "backfill needed" state that
    // pre-existing tenants were (see prisma/backfillCompanies.js).
    // Phase 1.1: marked isDefault: true explicitly, since this is the only
    // company the tenant has at signup - keeps this path consistent with
    // ensureDefaultCompany()'s own lazy-creation behavior (companyService.js).
    const company = await tx.company.create({
      data: { tenantId: tenant.id, name: businessName, code: 'MAIN', isDefault: true },
    });

    const branch = await tx.branch.create({
      data: { tenantId: tenant.id, companyId: company.id, name: 'Main Branch', isMain: true },
    });

    const user = await tx.user.create({
      data: {
        tenantId: tenant.id,
        branchId: branch.id,
        name: adminName,
        email: email.toLowerCase(),
        passwordHash,
        role: 'TENANT_ADMIN',
      },
    });

    return { tenant, user };
  });

  const token = signToken(result.user);
  res.status(201).json({
    token,
    user: sanitizeUser(result.user),
    tenant: result.tenant,
    // Phase 0.4: "effective permissions" for this role - lets the frontend
    // hide unauthorized actions without hardcoding role names. Backend
    // authorization (requirePermission) remains authoritative regardless.
    permissions: await effectivePermissionsForRole(result.user.role),
  });
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

async function login(req, res) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid login data', parsed.error.flatten());
  const { email, password } = parsed.data;

  // Emails are unique per tenant in the schema, so older data may hold one address in two tenants: pick the
  // account by password among the active ones instead of trusting an arbitrary first row.
  const candidates = await prisma.user.findMany({ where: { email: email.toLowerCase(), isActive: true } });
  let user = null;
  for (const c of candidates) {
    if (await verifyPassword(password, c.passwordHash)) { user = c; break; }
  }
  if (!candidates.length) await verifyAgainstDummy(password); // unknown email costs the same as a wrong password
  if (!user) throw new UnauthorizedError('Invalid email or password');

  let tenant = null;
  if (user.tenantId) {
    tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId } });
    if (!tenant || !tenant.isActive) throw new UnauthorizedError('Tenant account is inactive');
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const token = signToken(user);
  req.user = { id: user.id, tenantId: user.tenantId, role: user.role };
  await logAudit({ req, action: 'LOGIN', entity: 'User', entityId: user.id });

  // Phase 0.2: tenant (including enabledIndustryPacks) is returned here so
  // the frontend can decide which industry-specific Product fields to show
  // without a second round-trip - see docs/phase0-2-frontend-ui-architecture.md.
  res.json({ token, user: sanitizeUser(user), tenant, permissions: await effectivePermissionsForRole(user.role) });
}

async function me(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { tenant: true, branch: true },
  });
  res.json({
    user: sanitizeUser(user),
    tenant: user.tenant,
    branch: user.branch,
    permissions: await effectivePermissionsForRole(user.role),
  });
}

// --- Password reset / change ---------------------------------------------------------------------------------

const forgotSchema = z.object({ email: z.string().email() });
const GENERIC_FORGOT = { message: 'If an account exists for this email, a reset link has been sent.' };

async function forgotPassword(req, res) {
  const parsed = forgotSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid email', parsed.error.flatten());
  if (!mailer.isConfigured()) {
    // Honest: this installation cannot send email. A tenant admin can issue a reset link instead.
    return res.status(503).json({
      error: 'Email is not set up on this system. Ask your administrator for a reset link.',
      code: 'EMAIL_NOT_CONFIGURED',
    });
  }
  const users = await prisma.user.findMany({ where: { email: parsed.data.email.toLowerCase(), isActive: true } });
  for (const user of users) {
    const token = generateResetToken();
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hashResetToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
    });
    try {
      await mailer.sendMail({
        to: user.email,
        subject: 'Reset your BizOS password',
        text: `Use this link to choose a new password (valid for 1 hour):\n\n${resetLink(token)}\n\nIf you did not ask for this, ignore this email.`,
      });
    } catch (err) {
      // Delivery failure is reported to operators and never revealed to the caller (it would leak that the account exists).
      captureException(err, { source: 'password-reset-email' });
    }
  }
  res.json(GENERIC_FORGOT);
}

const resetSchema = z.object({ token: z.string().min(20), password: passwordSchema });

// Claiming the token and setting the password happen in ONE transaction; the conditional update makes a token
// single-use even when two requests submit it at the same moment.
async function resetPassword(req, res) {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid reset request', parsed.error.flatten());
  const { token, password } = parsed.data;
  const passwordHash = await hashPassword(password);
  const tokenHash = hashResetToken(token);

  const userId = await prisma.$transaction(async (tx) => {
    const claimed = await tx.passwordResetToken.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) return null;
    const row = await tx.passwordResetToken.findUnique({ where: { tokenHash } });
    const now = new Date();
    await tx.user.update({ where: { id: row.userId }, data: { passwordHash, passwordChangedAt: now } });
    // Any other outstanding reset links for this user die with the old password.
    await tx.passwordResetToken.updateMany({ where: { userId: row.userId, usedAt: null }, data: { usedAt: now } });
    return row.userId;
  });
  if (!userId) throw new ValidationError('This reset link is invalid or has expired. Request a new one.');

  const user = await prisma.user.findUnique({ where: { id: userId } });
  req.user = { id: user.id, tenantId: user.tenantId, role: user.role };
  await logAudit({ req, action: 'PASSWORD_RESET', entity: 'User', entityId: user.id });
  res.json({ message: 'Password updated. You can now sign in.' });
}

const changeSchema = z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema });

async function changePassword(req, res) {
  const parsed = changeSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid password data', parsed.error.flatten());
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
    throw new ValidationError('Current password is incorrect');
  }
  // Truncated to the second: the fresh token returned below is issued in this same second and must stay valid.
  const changedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(parsed.data.newPassword), passwordChangedAt: changedAt },
  });
  await logAudit({ req, action: 'PASSWORD_CHANGE', entity: 'User', entityId: user.id });
  res.json({ token: signToken(updated), message: 'Password changed. Other devices have been signed out.' });
}

function sanitizeUser(user) {
  const { passwordHash, ...rest } = user;
  return rest;
}

module.exports = {
  registerTenant, login, me, publicConfig, forgotPassword, resetPassword, changePassword,
  signupMode, resetLink, RESET_TTL_MS,
};
