// Customer Portal authentication - deliberately separate from the staff
// authenticate() middleware in src/middleware/auth.js. Portal tokens carry
// `typ: 'portal'` and resolve to a CustomerPortalAccount, never a User, so
// there is no code path by which a portal session can reach a staff-only
// route or vice versa.
const { verifyToken } = require('../../utils/jwt');
const { UnauthorizedError } = require('../../utils/errors');
const prisma = require('../../config/prisma');

async function authenticatePortal(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new UnauthorizedError('Missing or invalid authorization header');
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    throw new UnauthorizedError('Invalid or expired token');
  }
  if (payload.typ !== 'portal') {
    throw new UnauthorizedError('Invalid or expired token');
  }

  const account = await prisma.customerPortalAccount.findUnique({ where: { id: payload.sub } });
  if (!account || !account.isActive) {
    throw new UnauthorizedError('Account is inactive or no longer exists');
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: account.tenantId } });
  if (!tenant || !tenant.isActive) {
    throw new UnauthorizedError('This account is no longer available');
  }

  // req.portal is the ONLY identity available to portal routes - every
  // query must filter by both tenantId and customerId from here, never
  // from a path/body-supplied id, so one customer can never reach another
  // customer's (or another tenant's) records.
  req.portal = { accountId: account.id, customerId: account.customerId, tenantId: account.tenantId };
  next();
}

module.exports = { authenticatePortal };
