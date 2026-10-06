// Single error-reporting hook. Every unexpected server error (500s, uncaught exceptions, unhandled
// rejections) goes through captureException.
//
// It always logs to stderr. If ALERT_WEBHOOK_URL is set it also POSTs a short alert to that URL (the payload
// carries both `text` and `content`, so Slack, Discord and Mattermost incoming webhooks all accept it).
// Alerts contain only the error message, the request id, method and path - never request bodies, headers
// or tokens. Identical alerts are throttled and the total is capped, so an outage cannot flood the channel.
const THROTTLE_MS = 5 * 60 * 1000;
const MAX_PER_HOUR = 30;
const TIMEOUT_MS = 3000;

const lastSent = new Map(); // dedupe key -> timestamp
let windowStart = 0;
let sentInWindow = 0;

function shouldAlert(key, now) {
  if (now - windowStart > 60 * 60 * 1000) {
    windowStart = now;
    sentInWindow = 0;
  }
  if (sentInWindow >= MAX_PER_HOUR) return false;
  const prev = lastSent.get(key);
  if (prev !== undefined && now - prev < THROTTLE_MS) return false;
  lastSent.set(key, now);
  if (lastSent.size > 500) lastSent.delete(lastSent.keys().next().value);
  sentInWindow += 1;
  return true;
}

// Returns a promise that always resolves (never rejects), so callers that are about to exit the process can
// await it briefly, and request handlers can ignore it.
async function captureException(err, context = {}) {
  console.error('[error-tracking]', err?.message || err, context);

  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url || typeof fetch !== 'function') return;
  const message = String(err?.message || err).slice(0, 300);
  const where = [context.method, context.path].filter(Boolean).join(' ') || context.source || 'server';
  if (!shouldAlert(`${where}|${message}`, Date.now())) return;

  const text = `AK VisionFlow ${process.env.NODE_ENV || 'development'} error: ${message} (${where}${context.requestId ? `, request ${context.requestId}` : ''})`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Alerting must never break, or slow down, the request that failed.
  }
}

// Test helper: forget throttle state.
function _resetForTests() {
  lastSent.clear();
  windowStart = 0;
  sentInWindow = 0;
}

module.exports = { captureException, _resetForTests };
