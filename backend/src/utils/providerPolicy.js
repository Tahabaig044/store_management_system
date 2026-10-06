// Messaging / push delivery honesty.
//
// The only providers implemented today are mocks that report "SENT" without contacting anyone. That is fine
// for development and tests, but in production it would tell shop owners and customers that messages were
// delivered when nothing left the server. So in production the mock is replaced by a provider that reports
// an honest, permanent "not configured" failure, and features that depend on delivery (customer-portal OTP
// login, WhatsApp automation, owner push) report themselves as unavailable.
//
// A deliberate staging exception: ALLOW_MOCK_PROVIDERS=true.
function mockProvidersAllowed() {
  return process.env.NODE_ENV !== 'production' || process.env.ALLOW_MOCK_PROVIDERS === 'true';
}

// Used by real providers' registries: a provider that cannot deliver.
function notConfiguredProvider(what) {
  return {
    notConfigured: true,
    async send() {
      return {
        status: 'FAILED',
        providerMessageId: null,
        failureReason: `No ${what} provider is configured on this system, so nothing was delivered`,
        permanent: true,
        notConfigured: true,
      };
    },
  };
}

module.exports = { mockProvidersAllowed, notConfiguredProvider };
