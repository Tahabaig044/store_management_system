// Minimal SMTP sender, used only for password-reset emails. Configured entirely by environment:
//   SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASS, SMTP_FROM ("AK VisionFlow <no-reply@example.com>")
// With no SMTP_HOST the feature is off: isConfigured() is false, nothing is "sent", and the UI says so.
const nodemailer = require('nodemailer');

let transportOverride = null;

function isConfigured() {
  return Boolean(transportOverride || (process.env.SMTP_HOST && process.env.SMTP_FROM));
}

function getTransport() {
  if (transportOverride) return transportOverride;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

async function sendMail({ to, subject, text }) {
  if (!isConfigured()) throw new Error('SMTP is not configured');
  return getTransport().sendMail({ from: process.env.SMTP_FROM || 'no-reply@localhost', to, subject, text });
}

// Test hook: inject a fake transport ({ sendMail }).
function _setTransportForTests(t) {
  transportOverride = t;
}

module.exports = { isConfigured, sendMail, _setTransportForTests };
