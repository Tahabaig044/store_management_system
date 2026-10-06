// The provider-agnostic WhatsApp interface. Every provider implementation
// (mock, and eventually a real one like Twilio or Meta's Cloud API) must
// export the same shape: an async send() that returns
// { providerMessageId, status } and never throws for an ordinary delivery
// failure (it returns a FAILED-shaped result instead) - only truly
// unexpected errors should throw, and callers must handle even those
// without letting them escape into the business transaction that queued
// the message.
//
// Adding a real provider later means writing one more file matching this
// shape and switching CommunicationConfig.provider - nothing else in the
// codebase needs to change, which is the whole point of this abstraction.

const MockProvider = require('./mockProvider');
const { mockProvidersAllowed, notConfiguredProvider } = require('../../../utils/providerPolicy');

const PROVIDERS = {
  mock: MockProvider,
};

const NOT_CONFIGURED = notConfiguredProvider('WhatsApp');

function getProvider(name) {
  const provider = PROVIDERS[name] || PROVIDERS.mock;
  if (provider === MockProvider && !mockProvidersAllowed()) return NOT_CONFIGURED;
  return provider;
}

// True when a message sent through this provider would really be delivered (or, in dev/test, mock-delivered).
function isDeliveryAvailable(name) {
  return !getProvider(name).notConfigured;
}

module.exports = { getProvider, isDeliveryAvailable };
