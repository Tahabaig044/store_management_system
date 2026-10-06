// Phase 7.3: the frontend previously had no error-reporting path at all - a
// render crash or an uncaught exception in a real user's browser simply
// vanished with no visibility anywhere. This reuses the exact same
// captureException()/ALERT_WEBHOOK_URL mechanism backend errors already go
// through (utils/errorTracking.js) rather than introducing a second
// monitoring integration or a third-party SDK this environment has no
// credentials for.
//
// Deliberately unauthenticated: a crash can happen before login, or because
// auth itself is broken, and error reporting must never depend on the very
// thing that might be failing. Protected instead by its own tight rate limit
// (see app.js) and hard caps on every field's length, so it can never become
// an amplification/log-flooding vector.
const express = require('express');
const { z } = require('zod');
const { captureException } = require('../../utils/errorTracking');

const router = express.Router();

const schema = z.object({
  message: z.string().min(1).max(500),
  stack: z.string().max(4000).optional(),
  url: z.string().max(500).optional(),
  source: z.enum(['react-error-boundary', 'window-error', 'unhandled-rejection']).default('window-error'),
});

router.post('/', async (req, res) => {
  const parsed = schema.safeParse(req.body);
  // A malformed report is itself not worth erroring the client over - just
  // drop it. Reporting must never become one more thing that can fail loudly.
  if (parsed.success) {
    const { message, stack, url, source } = parsed.data;
    await captureException(new Error(message), { source: `frontend:${source}`, path: url, stack: stack?.slice(0, 1000) });
  }
  res.status(204).end();
});

module.exports = router;
