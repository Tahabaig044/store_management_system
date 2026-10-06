// Vercel serverless entry point - wraps the same Express app used by the
// standalone server (src/server.js) so behavior is identical either way.
module.exports = require('../src/app');
