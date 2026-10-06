require('dotenv').config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// The exact fallback shipped in .env.example - public in this repo, so it
// must never be the real secret in a production deployment.
const PLACEHOLDER_JWT_SECRET = 'change-this-to-a-long-random-string';

const nodeEnv = process.env.NODE_ENV || 'development';
const jwtSecret = required('JWT_SECRET');

// Production secret protection (Phase 12, REQ-12-019). Development/test
// behavior is unchanged - this only ever fires when NODE_ENV=production, so
// local dev and the test suite (which use their own throwaway secrets) are
// unaffected. The error message never echoes the secret's value.
if (nodeEnv === 'production' && jwtSecret === PLACEHOLDER_JWT_SECRET) {
  throw new Error(
    'JWT_SECRET is still set to the placeholder value from .env.example. ' +
      'Set a real, random JWT_SECRET before running in production.'
  );
}

if (nodeEnv === 'production' && jwtSecret.length < 32) {
  throw new Error('JWT_SECRET is too short for production: use at least 32 random characters (openssl rand -base64 48).');
}

module.exports = {
  nodeEnv,
  port: parseInt(process.env.PORT || '4000', 10),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  mobileJwtExpiresIn: process.env.MOBILE_JWT_EXPIRES_IN || '30d',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
