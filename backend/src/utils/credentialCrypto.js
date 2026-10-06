// Phase 7.1: encrypts a tenant's AI provider credentials (e.g. an Anthropic
// API key) at rest, closing a gap the final pre-Phase-7 audit found -
// `AiConfig.credentials` was a plain, unencrypted JSON column.
//
// Reuses the app's existing required, fail-closed-in-production JWT_SECRET as
// key material (via scrypt) rather than introducing a second required secret
// to configure/rotate/deploy - this is the "strongest architecture already
// supported by the application" the Phase 7.1 directive asks for, not a new
// one. Rotating JWT_SECRET will make previously-encrypted credentials
// unreadable (the same way it invalidates every outstanding session token),
// which is an accepted, documented trade-off, not a bug - a tenant admin
// simply re-enters the provider credential afterward via the existing
// PUT /api/ai/config, the same action as any ordinary credential rotation.
//
// AES-256-GCM: authenticated encryption, so a tampered ciphertext is
// rejected on decrypt rather than silently producing garbage credentials.
const crypto = require('crypto');
const { jwtSecret } = require('../config/env');

const ALGORITHM = 'aes-256-gcm';
const ENC_MARKER = 'aesgcm-v1';
const IV_LENGTH = 12; // 96-bit IV is the recommended size for GCM

let cachedKey;
function deriveKey() {
  if (!cachedKey) {
    cachedKey = crypto.scryptSync(jwtSecret, 'ak-visionflow-ai-credentials-v1', 32);
  }
  return cachedKey;
}

// Encrypts a plain JS object into an opaque, storable envelope. Returns
// `null`/`undefined` unchanged so "no credentials configured" stays exactly
// that, not an encrypted empty object.
function encryptCredentials(plainObject) {
  if (plainObject === null || plainObject === undefined) return plainObject;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plainObject), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    __enc: ENC_MARKER,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

// Decrypts an envelope produced by encryptCredentials back into the original
// object. A row written before this phase (plain JSON, no `__enc` marker) is
// returned as-is, unchanged - existing configured providers keep working
// without a data migration, and are transparently re-encrypted the next time
// the tenant admin saves their config through PUT /api/ai/config.
function decryptCredentials(stored) {
  if (!stored || typeof stored !== 'object' || stored.__enc !== ENC_MARKER) return stored;
  const decipher = crypto.createDecipheriv(ALGORITHM, deriveKey(), Buffer.from(stored.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(stored.authTag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(stored.ciphertext, 'base64')), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

module.exports = { encryptCredentials, decryptCredentials };
