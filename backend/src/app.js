require('express-async-errors');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const { corsOrigins, nodeEnv } = require('./config/env');
const errorHandler = require('./middleware/errorHandler');
const { captureException } = require('./utils/errorTracking');
const prisma = require('./config/prisma');
const APP_VERSION = require('../package.json').version;

// Process-level safety net (Phase 12, REQ-12-013). Registered here (not
// server.js) so it applies under both entry points - the standalone server
// (src/server.js) and the Vercel serverless wrapper (api/index.js), which
// both load this module. A truly uncaught exception means the process is in
// an unknown state - Node's own guidance is to log and exit rather than
// keep serving requests from a potentially corrupted process; an unhandled
// promise rejection is logged the same way but does not exit, since it is
// almost always recoverable and many in-flight requests could otherwise be
// aborted unnecessarily. Neither path exposes internal error detail to any
// client - both only ever log server-side via the same error-tracking hook
// used everywhere else.
process.on('uncaughtException', (err) => {
  // Give the alert (bounded by its own 3 s timeout) a chance to leave before the process exits.
  captureException(err, { source: 'uncaughtException' }).finally(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  captureException(reason instanceof Error ? reason : new Error(String(reason)), { source: 'unhandledRejection' });
});

const authRoutes = require('./modules/auth/auth.routes');
const userRoutes = require('./modules/users/users.routes');
const branchRoutes = require('./modules/branches/branches.routes');
const companyRoutes = require('./modules/companies/companies.routes');
const tenantRoutes = require('./modules/tenant/tenant.routes');
const permissionsRoutes = require('./modules/permissions/permissions.routes');
const modulesRoutes = require('./modules/modules/modules.routes');
const categoryRoutes = require('./modules/categories/categories.routes');
const brandRoutes = require('./modules/brands/brands.routes');
const unitRoutes = require('./modules/units/units.routes');
const productRoutes = require('./modules/products/products.routes');
const customerRoutes = require('./modules/customers/customers.routes');
const supplierRoutes = require('./modules/suppliers/suppliers.routes');
const purchaseRoutes = require('./modules/purchases/purchases.routes');
const saleRoutes = require('./modules/sales/sales.routes');
const inventoryRoutes = require('./modules/inventory/inventory.routes');
const opticalOrderRoutes = require('./modules/opticalOrders/opticalOrders.routes');
const expenseCategoryRoutes = require('./modules/expenseCategories/expenseCategories.routes');
const expenseRoutes = require('./modules/expenses/expenses.routes');
const paymentRoutes = require('./modules/payments/payments.routes');
const offlineRoutes = require('./modules/offline/offline.routes');
const syncRoutes = require('./modules/sync/sync.routes');
const { announceChanges } = require('./modules/sync/realtime');
const { receivablesRoutes, payablesRoutes } = require('./modules/receivables/receivables.routes');
const salesReturnRoutes = require('./modules/salesReturns/salesReturns.routes');
const purchaseReturnRoutes = require('./modules/purchaseReturns/purchaseReturns.routes');
const creditNoteRoutes = require('./modules/creditNotes/creditNotes.routes');
const debitNoteRoutes = require('./modules/debitNotes/debitNotes.routes');
const quotationRoutes = require('./modules/quotations/quotations.routes');
const salesOrderRoutes = require('./modules/salesOrders/salesOrders.routes');
const dashboardRoutes = require('./modules/dashboard/dashboard.routes');
const reportRoutes = require('./modules/reports/reports.routes');
const settingsRoutes = require('./modules/settings/settings.routes');
const accountsRoutes = require('./modules/accounting/accounts.routes');
const journalRoutes = require('./modules/accounting/journal.routes');
const openingBalancesRoutes = require('./modules/accounting/openingBalances.routes');
const accountingPeriodsRoutes = require('./modules/accounting/periods.routes');
const taxRatesRoutes = require('./modules/accounting/taxRates.routes');
const accountingReportsRoutes = require('./modules/accounting/reports.routes');
const purchaseRequestsRoutes = require('./modules/procurement/purchaseRequests.routes');
const rfqsRoutes = require('./modules/procurement/rfqs.routes');
const purchaseOrdersRoutes = require('./modules/procurement/purchaseOrders.routes');
const goodsReceiptsRoutes = require('./modules/procurement/goodsReceipts.routes');
const procurementReconciliationRoutes = require('./modules/procurement/reconciliation.routes');
const warehousesRoutes = require('./modules/warehouses/warehouses.routes');
const stockTransfersRoutes = require('./modules/warehouses/stockTransfers.routes');
const patientsRoutes = require('./modules/clinical/patients.routes');
const doctorsRoutes = require('./modules/clinical/doctors.routes');
const appointmentsRoutes = require('./modules/clinical/appointments.routes');
const examinationsRoutes = require('./modules/clinical/examinations.routes');
const clinicalPrescriptionsRoutes = require('./modules/clinical/clinicalPrescriptions.routes');
const labsRoutes = require('./modules/clinical/labs.routes');
const clinicalReportsRoutes = require('./modules/clinical/reports.routes');
const communicationConfigRoutes = require('./modules/communication/config.routes');
const clientErrorsRoutes = require('./modules/monitoring/clientErrors.routes');
const messageTemplatesRoutes = require('./modules/communication/templates.routes');
const messagesRoutes = require('./modules/communication/messages.routes');
const automationRulesRoutes = require('./modules/communication/automationRules.routes');
const notificationsRoutes = require('./modules/communication/notifications.routes');
const activityLogRoutes = require('./modules/activityLog/activityLog.routes');
const searchRoutes = require('./modules/search/search.routes');
const scheduledAutomationRoutes = require('./modules/communication/scheduled.routes');
const communicationReportsRoutes = require('./modules/communication/reports.routes');
const portalOtpAuthRoutes = require('./modules/portal/otpAuth.routes');
const portalRoutes = require('./modules/portal/portal.routes');
const aiConfigRoutes = require('./modules/ai/config.routes');
const aiAssistantRoutes = require('./modules/ai/assistant.routes');
const aiBriefRoutes = require('./modules/ai/brief.routes');
const aiForecastsRoutes = require('./modules/ai/forecasts.routes');
const aiInsightsRoutes = require('./modules/ai/insights.routes');
const aiUsageReportsRoutes = require('./modules/ai/usageReports.routes');
// Phase 0.7: Owner Mobile resumes. The Prisma models this depends on
// (DeviceToken/UserNotificationPreference/PushConfig, AiInsight.notifiedAt/
// notifiedSeverity) are now declared in schema.prisma, matching the
// migration that had already been sitting on disk - see
// docs/phase0-7-owner-android-compatibility-verification-report.md.
const mobileRoutes = require('./modules/mobile/mobile.routes');
const mobileDashboardRoutes = require('./modules/mobile/dashboard.routes');
const mobileAlertsRoutes = require('./modules/mobile/alerts.routes');
const mobileNotificationPreferencesRoutes = require('./modules/mobile/notificationPreferences.routes');
const mobilePushRegistrationRoutes = require('./modules/mobile/pushRegistration.routes');
const mobileAiAdvisorRoutes = require('./modules/mobile/aiAdvisor.routes');

const app = express();

// Trust the single reverse-proxy hop (Vercel's edge) so express-rate-limit
// (and req.ip generally) sees the real client IP from X-Forwarded-For rather
// than the proxy's own IP - without this, every request would appear to
// share one IP, making any IP-keyed rate limit (including the pre-existing
// auth limiters below) either useless (everyone shares one bucket) or a
// denial-of-service risk to legitimate users. `1` means "trust exactly one
// hop," which is correct for Vercel's setup and does not blindly trust an
// arbitrary client-supplied header chain.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({ origin: corsOrigins, credentials: true }));
app.use(express.json({ limit: '2mb' }));
if (nodeEnv !== 'test') app.use(morgan(nodeEnv === 'production' ? 'combined' : 'dev'));

// Request correlation ID (Phase 12, REQ-12-016) - always generated
// server-side, never trusting a client-supplied value (a caller could
// otherwise inject an arbitrary/misleading ID into server logs). Available
// to error logging via req.id and echoed back so a client can quote it when
// reporting an issue.
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
});

// Phase 3.4: after any successful write, tell the shop's other terminals that something changed. Mounted here,
// before every router, so it sees every write.
app.use('/api', announceChanges);

// Brute-force protection on auth endpoints only.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register-tenant', authLimiter);
// Password recovery has its own bucket so recovery attempts and normal logins never starve each other.
const passwordRecoveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, please try again later" },
});
app.use("/api/auth/forgot-password", passwordRecoveryLimiter);
app.use("/api/auth/reset-password", passwordRecoveryLimiter);

// Same brute-force protection applied to the Customer Portal's OTP
// endpoints - these are unauthenticated by nature (that's the point of an
// OTP login) so they are exactly as exposed to guessing/spam as password
// login and need the identical rate limit.
const portalOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
});
app.use('/api/portal/auth/request-otp', portalOtpLimiter);
app.use('/api/portal/auth/verify-otp', portalOtpLimiter);

// Owner Mobile's own login endpoint gets the same brute-force protection as
// staff/portal login - a separate limiter (not the shared `authLimiter`
// instance) so an attacker hammering one login surface can't exhaust the
// other tenants' owners' attempts on a shared counter.
const mobileLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
});
app.use('/api/mobile/v1/auth/login', mobileLoginLimiter);

// Phase 7.3: frontend error reports - unauthenticated by necessity (a crash
// can happen before login), so it gets the same brute-force-style protection
// as the other unauthenticated endpoints above, capping it well below the
// point where it could be used to flood the alert webhook or the server log.
const clientErrorLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many error reports, please try again later' },
});
app.use('/api/client-errors', clientErrorLimiter, clientErrorsRoutes);

// General API rate limiter (REQ-12-011, Phase 12 - Production Hardening).
// This is abuse/DoS protection, not a usage throttle: the ceiling is chosen
// to sit far above any realistic legitimate traffic pattern (see the Phase
// 12 report for the frontend request-frequency inspection this was based
// on - POS barcode scanning and product search are entirely client-side
// against an already-fetched product list and make zero additional API
// calls per scan/keystroke; the busiest legitimate poller in the app, the
// notification bell, makes one request per 30s per user). It sits alongside
// the stricter per-endpoint auth limiters above, not in place of them - a
// login attempt is still bound by the tighter 20-per-15-minutes limiter
// first.
//
// Keying prefers the caller's identity over their IP so office staff behind
// one shared IP don't share a single bucket: this reads the JWT's `sub`
// claim via a plain decode (not verification) purely to bucket the rate
// limit key - it is not a security boundary and never substitutes for each
// route's own real authenticate() check, so a forged/expired token can at
// worst only earn the forger their own dedicated bucket, never bypass or
// weaken anyone else's protection or any real authorization check.
function rateLimitKey(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme === 'Bearer' && token) {
    try {
      const decoded = jwt.decode(token);
      if (decoded?.sub) return `user:${decoded.sub}`;
    } catch {
      // fall through to IP
    }
  }
  return `ip:${req.ip}`;
}

const generalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  message: { error: 'Too many requests, please slow down and try again shortly' },
});
app.use('/api', generalApiLimiter);

// Database-aware health check (Phase 12, REQ-12-015) - stays unauthenticated
// exactly as before, but now reflects real service health rather than only
// process liveness. On failure, returns a generic "degraded" status without
// the underlying error message, connection string, or any DB-internal
// detail - only the correlation ID lets an operator find the real cause in
// server-side logs (via captureException), never the client response.
app.get('/api/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', version: APP_VERSION, time: new Date().toISOString(), requestId: req.id });
  } catch (err) {
    captureException(err, { source: 'health-check', requestId: req.id });
    res.status(503).json({ status: 'degraded', time: new Date().toISOString(), requestId: req.id });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/branches', branchRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api/tenant', tenantRoutes);
app.use('/api/permissions', permissionsRoutes);
app.use('/api/modules', modulesRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/brands', brandRoutes);
app.use('/api/units', unitRoutes);
app.use('/api/products', productRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/purchases', purchaseRoutes);
app.use('/api/sales', saleRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/optical-orders', opticalOrderRoutes);
app.use('/api/expense-categories', expenseCategoryRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/offline', offlineRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/receivables', receivablesRoutes);
app.use('/api/payables', payablesRoutes);
app.use('/api/sales-returns', salesReturnRoutes);
app.use('/api/purchase-returns', purchaseReturnRoutes);
app.use('/api/credit-notes', creditNoteRoutes);
app.use('/api/debit-notes', debitNoteRoutes);
app.use('/api/quotations', quotationRoutes);
app.use('/api/sales-orders', salesOrderRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/accounting/accounts', accountsRoutes);
app.use('/api/accounting/journal', journalRoutes);
app.use('/api/accounting/opening-balances', openingBalancesRoutes);
app.use('/api/accounting/periods', accountingPeriodsRoutes);
app.use('/api/accounting/tax-rates', taxRatesRoutes);
app.use('/api/accounting/reports', accountingReportsRoutes);
app.use('/api/procurement/purchase-requests', purchaseRequestsRoutes);
app.use('/api/procurement/rfqs', rfqsRoutes);
app.use('/api/procurement/purchase-orders', purchaseOrdersRoutes);
app.use('/api/procurement/goods-receipts', goodsReceiptsRoutes);
// Mounted last among the /api/procurement/* routers (order matters): its own routes
// (/purchase-orders/:id/reconciliation, /summary, /dashboard, /suppliers/:id/performance)
// only match after the more specific routers above have had first chance at the path.
app.use('/api/procurement', procurementReconciliationRoutes);
app.use('/api/warehouses', warehousesRoutes);
app.use('/api/stock-transfers', stockTransfersRoutes);
app.use('/api/patients', patientsRoutes);
app.use('/api/doctors', doctorsRoutes);
app.use('/api/appointments', appointmentsRoutes);
app.use('/api/examinations', examinationsRoutes);
app.use('/api/clinical-prescriptions', clinicalPrescriptionsRoutes);
app.use('/api/labs', labsRoutes);
app.use('/api/clinical-reports', clinicalReportsRoutes);
app.use('/api/communication/config', communicationConfigRoutes);
app.use('/api/communication/templates', messageTemplatesRoutes);
app.use('/api/communication/messages', messagesRoutes);
app.use('/api/communication/automation-rules', automationRulesRoutes);
app.use('/api/communication/reports', communicationReportsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/activity-log', activityLogRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/automation', scheduledAutomationRoutes);
app.use('/api/portal/auth', portalOtpAuthRoutes);
app.use('/api/portal', portalRoutes);
app.use('/api/ai/config', aiConfigRoutes);
app.use('/api/ai/assistant', aiAssistantRoutes);
app.use('/api/ai/brief', aiBriefRoutes);
app.use('/api/ai/forecasts', aiForecastsRoutes);
app.use('/api/ai/insights', aiInsightsRoutes);
app.use('/api/ai/usage', aiUsageReportsRoutes);
// Owner Mobile routes (/api/mobile/v1/*). Order matters: every specific
// sub-path router must be mounted BEFORE the bare '/api/mobile/v1' prefix
// (mobile.routes.js) - Express matches mount prefixes in registration
// order, and mobile.routes.js's own unconditional mobileReadOnlyGuard would
// otherwise intercept every sibling router's POST routes (alerts read/
// dismiss, notification-preferences PUT, push register/unregister) if it
// were mounted first.
app.use('/api/mobile/v1/dashboard', mobileDashboardRoutes);
app.use('/api/mobile/v1/alerts', mobileAlertsRoutes);
app.use('/api/mobile/v1/notification-preferences', mobileNotificationPreferencesRoutes);
app.use('/api/mobile/v1/push', mobilePushRegistrationRoutes);
app.use('/api/mobile/v1/ai', mobileAiAdvisorRoutes);
app.use('/api/mobile/v1', mobileRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

module.exports = app;
