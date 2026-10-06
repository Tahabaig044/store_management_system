// Phase 0.5: read-only introspection of the module registry (Core/Universal/
// Industry, dependencies, DB entities, routes) plus the one mutation this
// phase adds - letting a TENANT_ADMIN actually toggle an industry module on
// or off, closing the gap where Tenant.enabledIndustryPacks existed (Phase
// 0.2) but nothing ever let a tenant change it after signup.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { MODULE_REGISTRY, MODULE_REGISTRY_BY_ID } = require('../../constants/moduleRegistry');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');

const router = express.Router();
router.use(authenticate, requireTenant);

router.get('/', requirePermission('MODULE', 'VIEW'), (req, res) => {
  const enabledPacks = req.tenant?.enabledIndustryPacks || [];
  const items = MODULE_REGISTRY.map((m) => ({
    id: m.id,
    name: m.name,
    type: m.type,
    description: m.description,
    dependencies: m.dependencies,
    dbEntities: m.dbEntities,
    routePrefixes: m.routePrefixes,
    industryPackKey: m.industryPackKey || null,
    implemented: m.implemented !== false,
    // Core/Universal modules are always enabled; an unimplemented Industry
    // placeholder can never be "enabled" regardless of enabledIndustryPacks.
    enabled: m.type !== 'INDUSTRY' ? true : m.implemented !== false && enabledPacks.includes(m.industryPackKey),
  }));
  res.json({ items });
});

const updateSchema = z.object({ enabled: z.boolean() });

router.patch('/:id', requirePermission('MODULE', 'UPDATE'), async (req, res) => {
  const module = MODULE_REGISTRY_BY_ID.get(req.params.id);
  if (!module) throw new NotFoundError('Unknown module');
  if (module.type !== 'INDUSTRY') {
    throw new ConflictError('Only an industry module can be enabled or disabled');
  }
  if (module.implemented === false) {
    throw new ConflictError('This module is not yet implemented and cannot be enabled');
  }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid module update', parsed.error.flatten());

  const tenant = await prisma.tenant.findUnique({ where: { id: req.user.tenantId } });
  const current = new Set(tenant.enabledIndustryPacks);
  if (parsed.data.enabled) current.add(module.industryPackKey);
  else current.delete(module.industryPackKey);

  const updated = await prisma.tenant.update({
    where: { id: req.user.tenantId },
    data: { enabledIndustryPacks: [...current] },
  });

  await logAudit({
    req,
    action: parsed.data.enabled ? 'MODULE_ENABLE' : 'MODULE_DISABLE',
    entity: 'Tenant',
    entityId: updated.id,
    metadata: { moduleId: module.id },
  });

  res.json({ item: { id: module.id, name: module.name, enabled: parsed.data.enabled } });
});

module.exports = router;
