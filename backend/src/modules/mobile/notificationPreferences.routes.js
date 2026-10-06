// Owner Mobile notification preferences (Phase 3 spec section 7). Like
// alert read/dismiss, updating one's own notification settings is account
// metadata, not business data - registered before mobileReadOnlyGuard,
// same pattern as POST /auth/logout.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { ValidationError } = require('../../utils/errors');
const { authenticateMobile, mobileReadOnlyGuard } = require('../../middleware/mobileAuth');

const router = express.Router();
router.use(authenticateMobile);

async function getOrCreate(req) {
  const existing = await prisma.userNotificationPreference.findUnique({ where: { userId: req.user.id } });
  if (existing) return existing;
  return prisma.userNotificationPreference.create({ data: { tenantId: req.user.tenantId, userId: req.user.id } });
}

function toDto(pref) {
  return {
    dailySummaryEnabled: pref.dailySummaryEnabled,
    dailySummaryTime: pref.dailySummaryTime,
    salesAlertsEnabled: pref.salesAlertsEnabled,
    profitAlertsEnabled: pref.profitAlertsEnabled,
    receivableAlertsEnabled: pref.receivableAlertsEnabled,
    inventoryAlertsEnabled: pref.inventoryAlertsEnabled,
    expenseAnomalyAlertsEnabled: pref.expenseAnomalyAlertsEnabled,
    minimumPriority: pref.minimumPriority,
  };
}

const updateSchema = z.object({
  dailySummaryEnabled: z.boolean().optional(),
  dailySummaryTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm').optional(),
  salesAlertsEnabled: z.boolean().optional(),
  profitAlertsEnabled: z.boolean().optional(),
  receivableAlertsEnabled: z.boolean().optional(),
  inventoryAlertsEnabled: z.boolean().optional(),
  expenseAnomalyAlertsEnabled: z.boolean().optional(),
  minimumPriority: z.enum(['CRITICAL_ONLY', 'IMPORTANT_PLUS', 'ALL']).optional(),
});

router.put('/', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid notification preferences', parsed.error.flatten());
  if (Object.keys(parsed.data).length === 0) throw new ValidationError('No preference fields provided');

  const existing = await getOrCreate(req);
  const item = await prisma.userNotificationPreference.update({ where: { id: existing.id }, data: parsed.data });
  res.json({ item: toDto(item) });
});

router.use(mobileReadOnlyGuard);

router.get('/', async (req, res) => {
  const pref = await getOrCreate(req);
  res.json({ item: toDto(pref) });
});

module.exports = router;
