// Owner Mobile push-token registration (Phase 3's "Push Token Service").
// Registering/unregistering this device is account/session bookkeeping, not
// business data - no route here is guarded by mobileReadOnlyGuard, the same
// way POST /auth/login and /auth/logout are exempt in mobile.routes.js.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { ValidationError } = require('../../utils/errors');
const { authenticateMobile } = require('../../middleware/mobileAuth');

const router = express.Router();
router.use(authenticateMobile);

const registerSchema = z.object({
  token: z.string().min(10),
  platform: z.enum(['ANDROID']).default('ANDROID'),
});

router.post('/register-device', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid device token payload', parsed.error.flatten());
  const { token, platform } = parsed.data;

  const item = await prisma.deviceToken.upsert({
    where: { tenantId_token: { tenantId: req.user.tenantId, token } },
    create: { tenantId: req.user.tenantId, userId: req.user.id, token, platform, isActive: true },
    update: { userId: req.user.id, platform, isActive: true, lastSeenAt: new Date() },
  });
  res.json({ item: { id: item.id, platform: item.platform, isActive: item.isActive } });
});

const unregisterSchema = z.object({ token: z.string().min(10) });

router.post('/unregister-device', async (req, res) => {
  const parsed = unregisterSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid device token payload', parsed.error.flatten());

  await prisma.deviceToken.updateMany({
    where: { tenantId: req.user.tenantId, userId: req.user.id, token: parsed.data.token },
    data: { isActive: false },
  });
  res.json({ message: 'Device unregistered' });
});

module.exports = router;
