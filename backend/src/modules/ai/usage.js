// AI configuration lookup, per-tenant daily quota enforcement, and usage
// logging - the "usage & cost controls" required by the phase. The
// deterministic provider has no real per-call cost, but request counts are
// tracked identically regardless of provider so the quota mechanism and
// reporting are exercised the same way a paid provider would need.
const prisma = require('../../config/prisma');
const { ConflictError } = require('../../utils/errors');

async function getConfig(client, tenantId) {
  let config = await client.aiConfig.findUnique({ where: { tenantId } });
  if (!config) {
    config = await client.aiConfig.create({ data: { tenantId } });
  }
  return config;
}

function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

// Throws ConflictError (409) if the tenant has hit its daily AI request
// quota - callers must check this BEFORE doing any AI work, never after.
async function assertWithinQuota(tenantId) {
  const config = await getConfig(prisma, tenantId);
  if (!config.isEnabled) {
    throw new ConflictError('AI features are disabled for this account');
  }
  const count = await prisma.aiUsageLog.count({ where: { tenantId, createdAt: { gte: startOfDay() } } });
  if (count >= config.dailyRequestLimit) {
    throw new ConflictError('The daily AI usage limit has been reached for this account. Try again tomorrow, or use the standard reports.');
  }
  return config;
}

async function logUsage({ tenantId, userId, feature, provider, requestTokens = null, responseTokens = null, costEstimate = null }) {
  try {
    await prisma.aiUsageLog.create({ data: { tenantId, userId, feature, provider, requestTokens, responseTokens, costEstimate } });
  } catch (err) {
    console.error('[ai] failed to log usage:', err.message);
  }
}

module.exports = { getConfig, assertWithinQuota, logUsage };
