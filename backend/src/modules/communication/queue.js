// The message queue: creation, idempotent dedup, opt-out enforcement, and
// provider dispatch with exponential backoff. Every business route that
// triggers a customer message calls this AFTER its own transaction has
// already committed (see automation.js) - a messaging failure here can
// never roll back a sale, payment, optical order, or appointment, and a
// provider outage can never corrupt them either.
const { getProvider } = require('./providers/provider');
const { findExistingByIdempotencyKey } = require('../../utils/idempotency');

async function getConfig(client, tenantId) {
  let config = await client.communicationConfig.findUnique({ where: { tenantId } });
  if (!config) {
    config = await client.communicationConfig.create({ data: { tenantId } });
  }
  return config;
}

// Creates a message row. Returns { message, deduplicated }. A duplicate
// idempotencyKey (the same source event queuing twice - e.g. an offline
// sale that synced more than once) returns the original message instead of
// creating a second one.
async function queueMessage(client, {
  tenantId, channel = 'WHATSAPP', customerId, recipientPhone, templateId, body, branchId,
  idempotencyKey, sourceEventType, sourceId, triggeredByUserId, automationRuleId,
}) {
  if (idempotencyKey) {
    const existing = await findExistingByIdempotencyKey(client.message, tenantId, idempotencyKey);
    if (existing) return { message: existing, deduplicated: true };
  }

  let optedOut = false;
  if (channel === 'WHATSAPP' && customerId) {
    const pref = await client.customerCommunicationPreference.findUnique({ where: { customerId } });
    if (pref?.whatsappOptOut) optedOut = true;
  }

  const message = await client.message.create({
    data: {
      tenantId, channel, customerId, recipientPhone, templateId, body, branchId,
      status: optedOut ? 'CANCELLED' : 'QUEUED',
      failureReason: optedOut ? 'Customer has opted out of WhatsApp messages' : null,
      idempotencyKey, sourceEventType, sourceId, triggeredByUserId, automationRuleId,
    },
  });
  return { message, deduplicated: false };
}

// Attempts delivery of one QUEUED message via the tenant's configured
// provider. Never throws - a provider error becomes a FAILED/retry state on
// the message row itself, not an exception the caller has to handle.
async function dispatchMessage(client, messageId) {
  const message = await client.message.findUnique({ where: { id: messageId } });
  if (!message || message.status !== 'QUEUED') return message;

  if (message.channel !== 'WHATSAPP') {
    return client.message.update({ where: { id: message.id }, data: { status: 'SENT', sentAt: new Date() } });
  }

  const config = await getConfig(client, message.tenantId);
  if (!config.isEnabled) {
    return client.message.update({
      where: { id: message.id },
      data: { status: 'FAILED', failureReason: 'WhatsApp is disabled for this tenant' },
    });
  }

  const provider = getProvider(config.provider);
  let result;
  try {
    result = await provider.send({ recipientPhone: message.recipientPhone, body: message.body });
  } catch (err) {
    result = { status: 'FAILED', providerMessageId: null, failureReason: err.message };
  }

  if (result.status === 'FAILED' && result.permanent) {
    // Retrying cannot help (e.g. no provider is configured): fail once, visibly, without a retry loop.
    return client.message.update({
      where: { id: message.id },
      data: { status: 'FAILED', failureReason: result.failureReason, nextRetryAt: null },
    });
  }

  if (result.status === 'FAILED') {
    const retryCount = message.retryCount + 1;
    const maxRetries = 5;
    const backoffMinutes = Math.min(2 ** retryCount, 60); // exponential, capped at 1h
    return client.message.update({
      where: { id: message.id },
      data: {
        status: retryCount >= maxRetries ? 'FAILED' : 'QUEUED',
        failureReason: result.failureReason,
        retryCount,
        nextRetryAt: retryCount >= maxRetries ? null : new Date(Date.now() + backoffMinutes * 60000),
      },
    });
  }

  return client.message.update({
    where: { id: message.id },
    data: { status: 'SENT', providerMessageId: result.providerMessageId, sentAt: new Date() },
  });
}

// Queues then immediately attempts delivery - the common path for a
// business-event-triggered message, so it reaches "sent" in the same
// request under the mock provider (near-zero latency) without needing a
// separate background worker for the common case. Failed sends still fall
// back to the QUEUED+nextRetryAt state, picked up later by processQueue().
async function queueAndDispatch(client, params) {
  const { message, deduplicated } = await queueMessage(client, params);
  if (deduplicated || message.status !== 'QUEUED') return { message, deduplicated };
  const dispatched = await dispatchMessage(client, message.id);
  return { message: dispatched, deduplicated: false };
}

// Processes every message due for (re)send for a tenant. This codebase's
// backend runs as Vercel serverless functions with no persistent
// in-process timer, so a real deployment must wire this to an external
// scheduler (Vercel Cron, etc.) hitting POST /api/automation/run-scheduled.
async function processQueue(client, tenantId, limit = 50) {
  const due = await client.message.findMany({
    where: {
      tenantId,
      status: 'QUEUED',
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }],
    },
    take: limit,
  });
  const results = [];
  for (const m of due) results.push(await dispatchMessage(client, m.id));
  return results;
}

module.exports = { getConfig, queueMessage, dispatchMessage, queueAndDispatch, processQueue };
