// Phase 0.3: lazy default-company creation, mirroring the existing
// ensureDefaultWarehouse pattern (warehouses/warehouseStock.js). A tenant
// that never thinks about "companies" at all should never notice this
// concept exists - creating a branch with no companyId transparently gets
// it assigned to the tenant's default company, auto-created the first time
// it's needed.
//
// Phase 1.1: prefers the explicitly-marked `isDefault` company when one
// exists (set via PATCH /api/companies/:id, see companies.routes.js), and
// falls back to the original "earliest created" convention otherwise - so
// a tenant that never touches the new isDefault flag sees no change in
// behavior at all.
async function ensureDefaultCompany(client, tenantId) {
  const marked = await client.company.findFirst({ where: { tenantId, isDefault: true } });
  if (marked) return marked;

  const existing = await client.company.findFirst({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
  if (existing) return existing;

  const tenant = await client.tenant.findUnique({ where: { id: tenantId }, select: { businessName: true } });
  return client.company.create({
    data: { tenantId, name: tenant?.businessName || 'Main Company', code: 'MAIN', isDefault: true },
  });
}

module.exports = { ensureDefaultCompany };
