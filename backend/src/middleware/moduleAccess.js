// Phase 0.5: real enforcement of industry-module activation. Core and
// Universal modules are never gated (they're always available) - only
// `type: 'INDUSTRY'` modules from moduleRegistry.js are checked here, against
// the tenant's Tenant.enabledIndustryPacks (attached to req.tenant by
// authenticate() - see middleware/auth.js). This must run AFTER
// authenticate()/requireTenant() in a router's middleware chain, exactly
// like requirePermission().
const { MODULE_REGISTRY_BY_ID } = require('../constants/moduleRegistry');
const { ForbiddenError } = require('../utils/errors');

function requireModule(moduleId) {
  const module = MODULE_REGISTRY_BY_ID.get(moduleId);
  if (!module) {
    throw new Error(`requireModule: unknown module id "${moduleId}" - check constants/moduleRegistry.js`);
  }

  return (req, res, next) => {
    // Core/Universal modules are always enabled - nothing to check. Only an
    // INDUSTRY module can ever be disabled for a tenant.
    if (module.type !== 'INDUSTRY') return next();

    const enabledPacks = req.tenant?.enabledIndustryPacks || [];
    if (!enabledPacks.includes(module.industryPackKey)) {
      throw new ForbiddenError(`The ${module.name} module is not enabled for this tenant`);
    }
    next();
  };
}

module.exports = { requireModule };
