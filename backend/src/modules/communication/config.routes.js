// Tenant-level WhatsApp/communication configuration. `credentials` is
// write-only from the API's perspective - every read response strips it
// out, so a provider API key can never reach the frontend even by accident.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { TENANT_ADMIN_ONLY } = require('../../constants/roles');
const { ValidationError } = require('../../utils/errors');
const { getConfig } = require('./queue');

function redact(config) {
  if (!config) return config;
  const { credentials, ...rest } = config; // eslint-disable-line no-unused-vars
  return { ...rest, hasCredentials: !!credentials && Object.keys(credentials).length > 0 };
}

const router = express.Router();
router.use(authenticate, requireTenant, requireRole(...TENANT_ADMIN_ONLY));

router.get('/', async (req, res) => {
  const config = await getConfig(prisma, req.user.tenantId);
  res.json({ item: redact(config) });
});

const updateSchema = z.object({
  provider: z.string().optional(),
  credentials: z.record(z.string(), z.any()).optional(),
  isEnabled: z.boolean().optional(),
  businessHoursStart: z.number().int().min(0).max(23).optional(),
  businessHoursEnd: z.number().int().min(0).max(23).optional(),
  maxCampaignMessagesPerCustomerPerDay: z.number().int().positive().optional(),
  senderLabel: z.string().optional(),
});

router.put('/', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid communication config', parsed.error.flatten());

  const existing = await getConfig(prisma, req.user.tenantId);
  const item = await prisma.communicationConfig.update({ where: { id: existing.id }, data: parsed.data });
  res.json({ item: redact(item) });
});

module.exports = router;
