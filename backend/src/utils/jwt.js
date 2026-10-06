const jwt = require('jsonwebtoken');
const { jwtSecret, jwtExpiresIn, mobileJwtExpiresIn } = require('../config/env');

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      tenantId: user.tenantId,
      role: user.role,
    },
    jwtSecret,
    { expiresIn: jwtExpiresIn }
  );
}

function verifyToken(token) {
  // Pin the algorithm explicitly - defense-in-depth against algorithm-confusion
  // attacks even though this app only ever signs with an HMAC secret.
  return jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
}

// Customer Portal tokens carry a distinct `typ: 'portal'` claim so a
// leaked/reused portal token can never be presented to a staff-only route
// (and vice versa) even though both are signed with the same secret -
// authenticate() and authenticatePortal() each check this claim explicitly.
function signPortalToken(account) {
  return jwt.sign(
    { sub: account.id, customerId: account.customerId, tenantId: account.tenantId, typ: 'portal' },
    jwtSecret,
    { expiresIn: '7d' }
  );
}

// Owner Mobile (Android app) tokens carry a distinct `typ: 'mobile'` claim,
// the same isolation pattern used for Customer Portal tokens - a leaked or
// reused mobile token can never be presented to a staff-only web route (and
// vice versa) even though both are signed with the same secret and resolve
// to the same User table. See middleware/mobileAuth.js.
function signMobileToken(user) {
  return jwt.sign(
    { sub: user.id, tenantId: user.tenantId, role: user.role, typ: 'mobile' },
    jwtSecret,
    { expiresIn: mobileJwtExpiresIn }
  );
}

// A token issued before the user's last password change/reset is no longer valid. JWT `iat` has 1-second
// resolution, so the change time is truncated to the second (a token issued in the same second, e.g. the fresh
// one returned by change-password, stays valid).
function isIssuedBeforePasswordChange(payload, user) {
  if (!user.passwordChangedAt) return false;
  return (payload.iat || 0) < Math.floor(user.passwordChangedAt.getTime() / 1000);
}

module.exports = { isIssuedBeforePasswordChange, signToken, verifyToken, signPortalToken, signMobileToken };
