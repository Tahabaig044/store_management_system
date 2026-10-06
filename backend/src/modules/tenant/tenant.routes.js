// Phase 1.1: the tenant's own business profile. Previously a Tenant row
// could only be created at signup (auth.controller.js's register-tenant)
// and read via /api/auth/me/login - there was no way for a TENANT_ADMIN to
// ever update their business name, logo, currency, timezone, or tax IDs
// after signing up. This is a singular resource (there is exactly one
// tenant per authenticated session, the caller's own), so unlike
// branches/companies there is no :id in the URL and no list/create/delete -
// a tenant can never create or delete itself.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { ValidationError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('TENANT', 'VIEW'), async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: req.user.tenantId } });
  res.json({ tenant });
});

// enabledIndustryPacks is deliberately excluded here - that field is owned
// by the Phase 0.5 module-activation system (PATCH /api/modules/:id), which
// already validates module dependencies/implementation status before
// touching it; duplicating that here would let a caller bypass those checks.
const updateSchema = z.object({
  name: z.string().min(1).optional(),
  businessName: z.string().min(1).optional(),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().optional(),
  address: z.string().optional(),
  logoUrl: z.string().optional(),
  timezone: z.string().optional(),
  currency: z.string().optional(),
  ntn: z.string().optional(),
  strn: z.string().optional(),
});

router.patch('/', requirePermission('TENANT', 'UPDATE'), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid tenant profile data', parsed.error.flatten());

  const tenant = await prisma.tenant.update({ where: { id: req.user.tenantId }, data: parsed.data });
  await logAudit({ req, action: 'TENANT_PROFILE_UPDATE', entity: 'Tenant', entityId: tenant.id, metadata: { changedFields: Object.keys(parsed.data) } });
  res.json({ tenant });
});

module.exports = router;
