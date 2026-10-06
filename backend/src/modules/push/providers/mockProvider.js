// Safe default push provider: never makes an external call, always
// "succeeds" (unless the caller opts into a deterministic test failure via
// FORCE_FAILURE_TOKEN), exactly mirroring the WhatsApp mock provider
// (modules/communication/providers/mockProvider.js) so the whole alert →
// push pipeline is fully testable with zero external account/credentials.
const crypto = require('crypto');
const FORCE_FAILURE_TOKEN = 'FAIL_TEST';

async function send({ deviceToken }) {
  if (deviceToken === FORCE_FAILURE_TOKEN) {
    return { status: 'FAILED', providerMessageId: null, failureReason: 'Simulated provider failure' };
  }
  return { status: 'SENT', providerMessageId: `mock-push-${crypto.randomUUID()}`, failureReason: null };
}

module.exports = { send, FORCE_FAILURE_TOKEN };
