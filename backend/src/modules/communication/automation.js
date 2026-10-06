// The event-driven automation engine. Business routes call triggerEvent()
// as a fire-and-forget step AFTER their own transaction has already
// committed - a failure anywhere in here (a bad template, a provider
// error, a database hiccup) is caught and logged, never re-thrown, so it
// can never roll back or delay the underlying sale/payment/optical-order/
// appointment that already happened.
const { queueAndDispatch } = require('./queue');
const { renderTemplate } = require('./render');
const { getAccessibleBranchIds } = require('../../middleware/branchScope');

const DEFAULT_TEMPLATES = [
  { type: 'OPTICAL_ORDER_CONFIRMATION', name: 'Default Optical Order Confirmation', body: 'Hi {{customerName}}, your optical order {{orderNumber}} has been placed. Total: {{total}}. Thank you!' },
  { type: 'OPTICAL_JOB_READY', name: 'Default Job Ready', body: 'Hi {{customerName}}, great news - your optical order {{orderNumber}} is ready for collection!' },
  { type: 'OPTICAL_ORDER_DELIVERED', name: 'Default Order Delivered', body: 'Hi {{customerName}}, thank you for collecting order {{orderNumber}}. We hope you love it!' },
  { type: 'APPOINTMENT_CONFIRMATION', name: 'Default Appointment Confirmation', body: 'Hi {{customerName}}, your appointment is confirmed for {{scheduledAt}}.' },
  { type: 'APPOINTMENT_REMINDER', name: 'Default Appointment Reminder', body: 'Hi {{customerName}}, reminder: you have an appointment on {{scheduledAt}}. See you soon!' },
  { type: 'APPOINTMENT_CANCELLED', name: 'Default Appointment Cancelled', body: 'Hi {{customerName}}, your appointment on {{scheduledAt}} has been cancelled. Please contact us to reschedule.' },
  { type: 'PAYMENT_REMINDER', name: 'Default Payment Reminder', body: 'Hi {{customerName}}, you have an outstanding balance of {{amount}}. Please settle at your earliest convenience.' },
  { type: 'INVOICE_RECEIPT', name: 'Default Sale Receipt', body: 'Hi {{customerName}}, thank you for your purchase! Invoice {{invoiceNumber}}, total {{total}}.' },
];

// Sensible defaults per the phase's "high-value default automations" list.
// SALE_COMPLETED ships disabled - a WhatsApp receipt for every single POS
// sale is spammy for a busy shop by default; a tenant opts in.
const DEFAULT_RULES = [
  { event: 'OPTICAL_ORDER_CREATED', templateType: 'OPTICAL_ORDER_CONFIRMATION', name: 'Optical order confirmation' },
  { event: 'OPTICAL_JOB_READY', templateType: 'OPTICAL_JOB_READY', name: 'Job ready for collection' },
  { event: 'OPTICAL_ORDER_DELIVERED', templateType: 'OPTICAL_ORDER_DELIVERED', name: 'Order delivered thank-you' },
  { event: 'APPOINTMENT_BOOKED', templateType: 'APPOINTMENT_CONFIRMATION', name: 'Appointment confirmation' },
  { event: 'APPOINTMENT_APPROACHING', templateType: 'APPOINTMENT_REMINDER', name: 'Appointment reminder' },
  { event: 'INVOICE_OVERDUE', templateType: 'PAYMENT_REMINDER', name: 'Overdue payment reminder' },
  { event: 'SALE_COMPLETED', templateType: 'INVOICE_RECEIPT', name: 'Sale receipt', isEnabled: false },
  // Phase 1.15: PAYMENT_RECEIVED was already a pre-existing AutomationEvent
  // enum value with no default rule and no call site anywhere (a genuinely
  // orphaned, unwired event this phase's audit found) - this is the fix,
  // wiring it in alongside its new triggerEvent() call site in
  // payments.routes.js.
  { event: 'PAYMENT_RECEIVED', name: 'Payment received alert', actionType: 'IN_APP_NOTIFICATION' },
  { event: 'APPOINTMENT_NO_SHOW', name: 'No-show follow-up alert', actionType: 'IN_APP_NOTIFICATION' },
  { event: 'OPTICAL_JOB_DELAYED', name: 'Delayed job alert', actionType: 'IN_APP_NOTIFICATION' },
  { event: 'STOCK_LOW', name: 'Low stock alert', actionType: 'IN_APP_NOTIFICATION' },
  { event: 'EXPIRY_APPROACHING', name: 'Medicine expiry alert', actionType: 'IN_APP_NOTIFICATION' },
  { event: 'PURCHASE_APPROVED', name: 'Purchase order approved alert', actionType: 'IN_APP_NOTIFICATION' },
  { event: 'TRANSFER_COMPLETED', name: 'Stock transfer completed alert', actionType: 'IN_APP_NOTIFICATION' },
  { event: 'CUSTOMER_INACTIVE', name: 'Inactive customer follow-up opportunity', actionType: 'IN_APP_NOTIFICATION' },
  { event: 'DAILY_CLOSE', name: 'Daily owner summary', actionType: 'IN_APP_NOTIFICATION' },
  // Phase 1.15: internal alerts for the newly-wired financial/document
  // events (see this phase's report, Notification Types/Events) - all
  // IN_APP_NOTIFICATION, mirroring STOCK_LOW/PURCHASE_APPROVED/
  // TRANSFER_COMPLETED's identical existing pattern for staff-facing alerts
  // with no customer-facing message counterpart.
  { event: 'SALE_CANCELLED', name: 'Sale cancelled alert', actionType: 'IN_APP_NOTIFICATION' },
  { event: 'PAYMENT_REVERSED', name: 'Payment reversed alert', actionType: 'IN_APP_NOTIFICATION' },
  { event: 'EXPENSE_CREATED', name: 'Expense recorded alert', actionType: 'IN_APP_NOTIFICATION' },
  { event: 'EXPENSE_REVERSED', name: 'Expense reversed alert', actionType: 'IN_APP_NOTIFICATION' },
  { event: 'RETURN_CREATED', name: 'Return recorded alert', actionType: 'IN_APP_NOTIFICATION' },
  { event: 'CREDIT_NOTE_CREATED', name: 'Credit note issued alert', actionType: 'IN_APP_NOTIFICATION' },
  { event: 'DEBIT_NOTE_CREATED', name: 'Debit note issued alert', actionType: 'IN_APP_NOTIFICATION' },
  { event: 'QUOTATION_ACCEPTED', name: 'Quotation accepted alert', actionType: 'IN_APP_NOTIFICATION' },
  { event: 'SALES_ORDER_CONFIRMED', name: 'Sales order confirmed alert', actionType: 'IN_APP_NOTIFICATION' },
  { event: 'SALES_ORDER_CANCELLED', name: 'Sales order cancelled alert', actionType: 'IN_APP_NOTIFICATION' },
];

// Idempotent: safe to call before every triggerEvent - only creates rows
// the first time a tenant needs them, same pattern as Phase 5's default
// Chart of Accounts.
async function ensureDefaultAutomations(client, tenantId) {
  const existingRules = await client.automationRule.count({ where: { tenantId, isSystem: true } });
  if (existingRules >= DEFAULT_RULES.length) return;

  const templatesByType = new Map();
  for (const t of DEFAULT_TEMPLATES) {
    const created = await client.messageTemplate.upsert({
      where: { tenantId_type_name: { tenantId, type: t.type, name: t.name } },
      create: { tenantId, type: t.type, name: t.name, body: t.body, isSystem: true },
      update: {},
    });
    templatesByType.set(t.type, created);
  }
  for (const r of DEFAULT_RULES) {
    const existing = await client.automationRule.findFirst({ where: { tenantId, event: r.event, isSystem: true } });
    if (existing) continue;
    await client.automationRule.create({
      data: {
        tenantId,
        event: r.event,
        name: r.name,
        actionType: r.actionType || 'WHATSAPP_MESSAGE',
        templateId: r.templateType ? templatesByType.get(r.templateType)?.id : null,
        isEnabled: r.isEnabled !== false,
        isSystem: true,
      },
    });
  }
}

// Only safe, narrow fields - never arbitrary code. `context` carries
// whatever the caller passed as `variables` plus branchId.
function conditionsMatch(conditions, context) {
  if (!conditions || typeof conditions !== 'object') return true;
  for (const [key, expected] of Object.entries(conditions)) {
    if (key === 'minAmount') {
      if (!(Number(context.amount) >= Number(expected))) return false;
      continue;
    }
    if (key === 'branchId') {
      if (expected && context.branchId !== expected) return false;
      continue;
    }
    if (context[key] !== undefined && context[key] !== expected) return false;
  }
  return true;
}

// Phase 1.15: when `branchId` is given, a candidate recipient is only
// notified if they can actually access that branch - reuses the existing,
// unmodified getAccessibleBranchIds() three-tier check (own branch /
// UserBranchAccess / company-wide) rather than a new isolation mechanism.
// TENANT_ADMIN/MANAGER (branch-unrestricted) always receive it, exactly like
// every other branch-scoped query in this codebase. When `branchId` is
// omitted, behavior is completely unchanged from before this phase -
// every matching-role active user is notified tenant-wide.
async function createRoleNotifications(client, tenantId, { type, title, body, link, targetRoles, branchId, entityType, entityId, priority }) {
  const roles = targetRoles || ['TENANT_ADMIN', 'MANAGER'];
  const users = await client.user.findMany({ where: { tenantId, role: { in: roles }, isActive: true }, select: { id: true, role: true, branchId: true } });

  let recipients = users;
  if (branchId) {
    const checks = await Promise.all(
      users.map(async (u) => {
        const accessibleIds = await getAccessibleBranchIds(client, u);
        return accessibleIds === null || accessibleIds.includes(branchId);
      })
    );
    recipients = users.filter((_, i) => checks[i]);
  }

  await Promise.all(
    recipients.map((u) =>
      client.notification.create({
        data: { tenantId, userId: u.id, branchId: branchId ?? null, type, title, body, link, entityType, entityId, priority },
      })
    )
  );
}

// The one function every business route calls. `sourceId` is the
// idempotency anchor - the SAME sourceId for a rule can only ever execute
// once (enforced by AutomationExecution's unique constraint), which is
// exactly what makes a re-synced offline transaction, or a retried
// request, safe from duplicate messages. For events with no single source
// record (DAILY_CLOSE, CUSTOMER_INACTIVE), callers must pass a synthetic,
// naturally-deduplicating id (e.g. "daily-close:2026-09-12").
async function triggerEvent(client, { tenantId, event, sourceId, branchId, customer, variables = {}, internalTitle, internalBody, targetRoles, entityType, priority }) {
  try {
    await ensureDefaultAutomations(client, tenantId);
    const rules = await client.automationRule.findMany({ where: { tenantId, event, isEnabled: true }, include: { template: true } });

    for (const rule of rules) {
      if (!conditionsMatch(rule.conditions, { branchId, ...variables })) continue;

      let execution;
      try {
        execution = await client.automationExecution.create({
          data: { tenantId, automationRuleId: rule.id, event, sourceId: sourceId ?? null, status: 'SKIPPED' },
        });
      } catch (err) {
        if (err.code === 'P2002') continue; // already executed for this (rule, sourceId) - silently skip, not a failure
        throw err;
      }

      try {
        let messageId = null;
        if (rule.actionType === 'WHATSAPP_MESSAGE') {
          if (rule.template && customer?.phone) {
            const body = renderTemplate(rule.template.body, variables);
            const { message } = await queueAndDispatch(client, {
              tenantId,
              channel: 'WHATSAPP',
              customerId: customer.id,
              recipientPhone: customer.phone,
              templateId: rule.templateId,
              body,
              // Phase 0.3 fix: branchId was previously accepted here but
              // never forwarded, so Message.branchId was always null and
              // branch-scope enforcement on messages.routes.js was a no-op.
              branchId,
              idempotencyKey: `auto:${rule.id}:${sourceId}`,
              sourceEventType: event,
              sourceId,
              automationRuleId: rule.id,
            });
            messageId = message.id;
          }
        } else {
          await createRoleNotifications(client, tenantId, {
            type: event,
            title: internalTitle || rule.name,
            body: internalBody || (rule.template ? renderTemplate(rule.template.body, variables) : null),
            link: variables.link,
            targetRoles,
            branchId,
            // sourceId already IS "the id of the record this event is
            // about" in every existing call site (it's the idempotency
            // anchor) - reusing it as entityId needs no new parameter.
            entityType,
            entityId: sourceId,
            priority,
          });
        }
        await client.automationExecution.update({ where: { id: execution.id }, data: { status: 'SUCCESS', messageId } });
      } catch (err) {
        await client.automationExecution.update({ where: { id: execution.id }, data: { status: 'FAILED', error: err.message } });
      }
    }
  } catch (err) {
    // Never let an automation failure escape into the caller's request.
    console.error(`[automation] triggerEvent(${event}) failed:`, err.message);
  }
}

module.exports = { triggerEvent, ensureDefaultAutomations, DEFAULT_TEMPLATES, DEFAULT_RULES };
