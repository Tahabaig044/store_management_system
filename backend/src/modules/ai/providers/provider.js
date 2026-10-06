// Provider abstraction, same pattern as Phase 8's messaging providers
// (src/modules/communication/providers/provider.js): application code
// never talks to a specific AI provider directly, only through this
// registry, so a real hosted LLM can be added later as a drop-in module
// without touching any calling code. Every provider call in this codebase
// is wrapped by callProvider() below, which enforces a timeout and falls
// back to the deterministic provider on any failure or timeout - AI must
// never block or break a core business operation (Phase 9 non-negotiable rule).
const deterministicProvider = require('./deterministicProvider');
const anthropicProvider = require('./anthropicProvider');

const PROVIDERS = {
  deterministic: deterministicProvider,
  anthropic: anthropicProvider,
};

// Exposed for tests only - lets a test register a deliberately-failing (or
// slow) provider to exercise the timeout/failure fallback path without
// shipping a fake provider in production code, mirroring how Phase 8's
// mock WhatsApp provider uses a reserved sentinel for the same purpose.
function registerProvider(name, providerModule) {
  PROVIDERS[name] = providerModule;
}

function getProvider(name) {
  return PROVIDERS[name] || null;
}

const DEFAULT_TIMEOUT_MS = 8000;

// Always resolves - never throws and never hangs past the timeout. An
// unregistered/unknown provider name, a provider that throws, and a
// provider that exceeds the timeout all take the exact same path: fall
// back to the deterministic provider and report `fellBack: true`, so the
// caller can never be silently mislabeled as having used a provider it
// didn't actually use.
async function callProvider(providerName, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const provider = getProvider(providerName);
  const withTimeout = (p) => Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error('AI provider timed out')), timeoutMs)),
  ]);

  if (provider && provider !== deterministicProvider) {
    try {
      const result = await withTimeout(provider.ask(args));
      return { ...result, provider: providerName, fellBack: false };
    } catch (err) {
      console.error(`[ai] provider "${providerName}" failed, falling back to deterministic:`, err.message);
    }
  }

  const fallback = await deterministicProvider.ask(args);
  return { ...fallback, provider: 'deterministic', fellBack: providerName !== 'deterministic' };
}

module.exports = { getProvider, callProvider, registerProvider };
