// Default provider: makes zero external network calls. Lets a tenant use
// and test the full automation/queue/retry system before ever connecting a
// real WhatsApp Business API account, and lets this codebase's automated
// tests exercise real send/fail/retry paths deterministically without a
// live provider or the flakiness of mocking network calls.
const crypto = require('crypto');

// A reserved sentinel recipient phone number that deterministically fails -
// used by tests to exercise retry/failure handling without any randomness.
const FORCE_FAILURE_PHONE = 'FAIL_TEST';

async function send({ recipientPhone }) {
  if (recipientPhone === FORCE_FAILURE_PHONE) {
    return { status: 'FAILED', providerMessageId: null, failureReason: 'Simulated provider failure' };
  }
  return { status: 'SENT', providerMessageId: `mock-${crypto.randomUUID()}`, failureReason: null };
}

module.exports = { send, FORCE_FAILURE_PHONE };
