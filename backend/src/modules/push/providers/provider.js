// Pluggable push-notification provider registry, mirroring
// modules/communication/providers/provider.js exactly. A provider module
// exports an async send({ deviceToken, title, body, data }) that returns
// { status: 'SENT'|'FAILED', providerMessageId, failureReason } and never
// throws for an ordinary delivery failure - only a truly unexpected error
// may throw, and even that is caught by the caller (see ../pushService.js).
//
// "mock" is the only provider today (no Firebase project/credentials exist
// for this app yet - see PushConfig.provider). Adding a real "fcm" entry
// here later, backed by firebase-admin and PushConfig.credentials, activates
// real delivery for any tenant whose PushConfig.provider is switched to
// "fcm" - no other code changes required.
const MockProvider = require('./mockProvider');
const { mockProvidersAllowed, notConfiguredProvider } = require('../../../utils/providerPolicy');

const PROVIDERS = {
  mock: MockProvider,
};

const NOT_CONFIGURED = notConfiguredProvider('push notification');

function getProvider(name) {
  const provider = PROVIDERS[name] || PROVIDERS.mock;
  if (provider === MockProvider && !mockProvidersAllowed()) return NOT_CONFIGURED;
  return provider;
}

function isDeliveryAvailable(name) {
  return !getProvider(name).notConfigured;
}

module.exports = { getProvider, isDeliveryAvailable };
