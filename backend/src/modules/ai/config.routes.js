// Tenant-level AI enable/disable and provider configuration. `credentials`
// (for a future real provider) is write-only from the API's perspective -
// every read response strips it out, mirroring Phase 8's CommunicationConfig.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { TENANT_ADMIN_ONLY } = require('../../constants/roles');
const { ValidationError } = require('../../utils/errors');
const { getConfig } = require('./usage');
const { encryptCredentials } = require('../../utils/credentialCrypto');

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
  isEnabled: z.boolean().optional(),
  provider: z.string().optional(),
  credentials: z.record(z.string(), z.any()).optional(),
  dailyRequestLimit: z.number().int().positive().optional(),
});

router.put('/', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid AI configuration', parsed.error.flatten());

  // Phase 7.1: credentials are encrypted before they ever reach the database -
  // this is the only place a real API key is written, and it never leaves
  // this process in plaintext (encryptCredentials, not a hash, since the
  // provider call later needs the real key back, not just a comparison).
  const data = { ...parsed.data };
  if ('credentials' in data) data.credentials = encryptCredentials(data.credentials);

  const existing = await getConfig(prisma, req.user.tenantId);
  const item = await prisma.aiConfig.update({ where: { id: existing.id }, data });
  res.json({ item: redact(item) });
});

module.exports = router;
