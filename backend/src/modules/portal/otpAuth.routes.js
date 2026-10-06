// Customer Portal login: OTP-over-WhatsApp, no password. A customer only
// ever needs the phone number already on file with the shop plus a
// tenantId (the portal is reached via a tenant-specific link/QR, so the
// frontend always knows which tenant it's asking about). Every response
// here is deliberately generic about whether a matching customer exists,
// to avoid leaking which phone numbers are registered.
const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { hashPassword, verifyPassword } = require('../../utils/password');
const { signPortalToken } = require('../../utils/jwt');
const { UnauthorizedError, ValidationError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { queueAndDispatch } = require('../communication/queue');
const { isDeliveryAvailable } = require('../communication/providers/provider');

const OTP_TTL_MINUTES = 5;
const MAX_ATTEMPTS = 5;
const GENERIC_MESSAGE = { message: 'If an account exists for this number, a verification code has been sent.' };

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

async function findCustomer(tenantId, phone) {
  return prisma.customer.findFirst({
    where: { tenantId, phone, isActive: true },
    orderBy: { createdAt: 'desc' },
  });
}

const router = express.Router();

const requestSchema = z.object({ tenantId: z.string().uuid(), phone: z.string().min(5) });

router.post('/request-otp', async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid request', parsed.error.flatten());
  const { tenantId, phone } = parsed.data;

  // A code that can never arrive is worse than an honest "not available": refuse before creating anything.
  const config = await prisma.communicationConfig.findUnique({ where: { tenantId } });
  if (!isDeliveryAvailable(config?.provider || 'mock') || (config && !config.isEnabled)) {
    return res.status(503).json({ error: 'Customer portal sign-in is not available right now. Please contact the shop.', code: 'PORTAL_UNAVAILABLE' });
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  const customer = tenant?.isActive ? await findCustomer(tenantId, phone) : null;

  if (customer) {
    const account = await prisma.customerPortalAccount.upsert({
      where: { customerId: customer.id },
      create: { tenantId, customerId: customer.id },
      update: { isActive: true },
    });

    const code = generateCode();
    const codeHash = await hashPassword(code);
    await prisma.customerPortalOtp.create({
      data: { accountId: account.id, codeHash, expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60000) },
    });

    await queueAndDispatch(prisma, {
      tenantId,
      channel: 'WHATSAPP',
      customerId: customer.id,
      recipientPhone: customer.phone,
      body: `Your verification code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes.`,
      sourceEventType: 'PORTAL_OTP',
    });
  }

  res.json(GENERIC_MESSAGE);
});

const verifySchema = z.object({ tenantId: z.string().uuid(), phone: z.string().min(5), code: z.string().length(6) });

router.post('/verify-otp', async (req, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid request', parsed.error.flatten());
  const { tenantId, phone, code } = parsed.data;

  const customer = await findCustomer(tenantId, phone);
  const account = customer ? await prisma.customerPortalAccount.findUnique({ where: { customerId: customer.id } }) : null;
  if (!account || !account.isActive) throw new UnauthorizedError('Invalid or expired code');

  const otp = await prisma.customerPortalOtp.findFirst({
    where: { accountId: account.id, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!otp || otp.attempts >= MAX_ATTEMPTS) throw new UnauthorizedError('Invalid or expired code');

  const valid = await verifyPassword(code, otp.codeHash);
  if (!valid) {
    await prisma.customerPortalOtp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    throw new UnauthorizedError('Invalid or expired code');
  }

  await prisma.$transaction([
    prisma.customerPortalOtp.update({ where: { id: otp.id }, data: { consumedAt: new Date() } }),
    prisma.customerPortalAccount.update({ where: { id: account.id }, data: { lastLoginAt: new Date() } }),
  ]);

  const token = signPortalToken(account);
  req.portal = { accountId: account.id, customerId: account.customerId, tenantId: account.tenantId };
  await logAudit({ req, action: 'PORTAL_LOGIN', entity: 'CustomerPortalAccount', entityId: account.id, metadata: { customerId: account.customerId, portalEvent: true } });

  res.json({ token, customer: { id: customer.id, name: customer.name, phone: customer.phone, email: customer.email } });
});

module.exports = router;
