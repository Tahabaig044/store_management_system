// Native bcrypt runs on libuv's thread pool, so a login does not freeze every other request the way the
// pure-JavaScript implementation does (measured: ~0.9 s of blocked event loop per login on a modest CPU).
// Both produce standard bcrypt hashes and verify each other's, so existing passwords keep working. If the
// native binary cannot load on some platform, fall back to the pure-JS implementation rather than fail.
let bcrypt;
try {
  bcrypt = require('bcrypt');
} catch (err) {
  console.warn('[password] native bcrypt unavailable, using bcryptjs:', err.message);
  bcrypt = require('bcryptjs');
}
const crypto = require('crypto');
const { z } = require('zod');

const SALT_ROUNDS = 12;

async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// The one password policy, used by registration, user management, reset and change-password.
// 72 is bcrypt's real limit (longer input is silently truncated), so longer passwords are refused rather
// than giving a false sense of strength.
const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters')
  .refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), 'Password must include at least one letter and one number');

// Reset tokens: 256 random bits, handed to the user once; only the SHA-256 is stored.
function generateResetToken() {
  return crypto.randomBytes(32).toString('base64url');
}
function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// A real bcrypt hash of a random string, so a login for an unknown email costs the same as a wrong password
// (otherwise response time reveals which emails have accounts).
let dummyHash;
async function verifyAgainstDummy(plain) {
  if (!dummyHash) dummyHash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), SALT_ROUNDS);
  return bcrypt.compare(plain, dummyHash);
}

module.exports = { hashPassword, verifyPassword, passwordSchema, generateResetToken, hashResetToken, verifyAgainstDummy };
