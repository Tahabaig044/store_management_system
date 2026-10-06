// Phase 0.4: the single source of truth for the Permission/RolePermission
// catalog. Deliberately mirrors this codebase's EXISTING role-group
// behavior (constants/roles.js and each route file's requireRole(...) call)
// exactly, so seeding this catalog is a zero-behavior-change migration for
// every resource this phase does not explicitly rewire to enforce via
// requirePermission() - see docs/phase0-4-authorization-architecture.md
// for which resources are actually wired to the new middleware in this
// phase, versus documented here for a future incremental migration.
//
// Each entry: { resource, actions: [{ action, roles }] }. `roles` uses the
// same RoleName values as the existing role-group constants.

const TENANT_ADMIN_ONLY = ['TENANT_ADMIN'];
const MANAGEMENT = ['TENANT_ADMIN', 'MANAGER'];
const INVENTORY_STAFF = ['TENANT_ADMIN', 'MANAGER', 'STORE_KEEPER'];
const SALES_STAFF = ['TENANT_ADMIN', 'MANAGER', 'CASHIER'];
const FRONT_DESK = ['TENANT_ADMIN', 'MANAGER', 'RECEPTIONIST'];
const FINANCE_STAFF = ['TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT'];
const CONTACTS_STAFF = ['TENANT_ADMIN', 'MANAGER', 'CASHIER', 'STORE_KEEPER', 'RECEPTIONIST', 'ACCOUNTANT'];
const CLINICAL_STAFF = ['TENANT_ADMIN', 'MANAGER', 'DOCTOR', 'RECEPTIONIST'];
const COMMUNICATION_STAFF = ['TENANT_ADMIN', 'MANAGER', 'RECEPTIONIST', 'ACCOUNTANT'];
const ALL_ROLES = ['TENANT_ADMIN', 'MANAGER', 'CASHIER', 'STORE_KEEPER', 'RECEPTIONIST', 'ACCOUNTANT', 'DOCTOR'];

const PERMISSION_CATALOG = [
  { resource: 'PRODUCT', actions: [
    { action: 'VIEW', roles: CONTACTS_STAFF },
    { action: 'CREATE', roles: INVENTORY_STAFF },
    { action: 'UPDATE', roles: INVENTORY_STAFF },
    { action: 'DELETE', roles: INVENTORY_STAFF },
  ] },
  { resource: 'CATEGORY', actions: [
    { action: 'VIEW', roles: CONTACTS_STAFF },
    { action: 'CREATE', roles: INVENTORY_STAFF },
    { action: 'UPDATE', roles: INVENTORY_STAFF },
    { action: 'DELETE', roles: INVENTORY_STAFF },
  ] },
  // Phase 1.5: Brand/Unit management mirrors Category's own permission
  // shape exactly - all three are the same kind of universal, tenant-owned
  // classification/measurement master data.
  { resource: 'BRAND', actions: [
    { action: 'VIEW', roles: CONTACTS_STAFF },
    { action: 'CREATE', roles: INVENTORY_STAFF },
    { action: 'UPDATE', roles: INVENTORY_STAFF },
    { action: 'DELETE', roles: INVENTORY_STAFF },
  ] },
  { resource: 'UNIT', actions: [
    { action: 'VIEW', roles: CONTACTS_STAFF },
    { action: 'CREATE', roles: INVENTORY_STAFF },
    { action: 'UPDATE', roles: INVENTORY_STAFF },
    { action: 'DELETE', roles: INVENTORY_STAFF },
  ] },
  { resource: 'CUSTOMER', actions: [
    { action: 'VIEW', roles: CONTACTS_STAFF },
    { action: 'CREATE', roles: CONTACTS_STAFF },
    { action: 'UPDATE', roles: CONTACTS_STAFF },
    { action: 'DELETE', roles: CONTACTS_STAFF },
  ] },
  { resource: 'SUPPLIER', actions: [
    { action: 'VIEW', roles: CONTACTS_STAFF },
    { action: 'CREATE', roles: INVENTORY_STAFF },
    { action: 'UPDATE', roles: INVENTORY_STAFF },
    { action: 'DELETE', roles: INVENTORY_STAFF },
  ] },
  { resource: 'BRANCH', actions: [
    { action: 'VIEW', roles: ALL_ROLES },
    { action: 'CREATE', roles: TENANT_ADMIN_ONLY },
    { action: 'UPDATE', roles: TENANT_ADMIN_ONLY },
    { action: 'DELETE', roles: TENANT_ADMIN_ONLY },
  ] },
  { resource: 'COMPANY', actions: [
    { action: 'VIEW', roles: ALL_ROLES },
    { action: 'CREATE', roles: TENANT_ADMIN_ONLY },
    { action: 'UPDATE', roles: TENANT_ADMIN_ONLY },
    { action: 'DELETE', roles: TENANT_ADMIN_ONLY },
  ] },
  // Phase 1.1: the tenant's own business profile (name, logo, currency,
  // timezone, tax IDs). Every role can already see this today via
  // /api/auth/me and the app header, so VIEW matches that existing exposure;
  // only TENANT_ADMIN may change it.
  { resource: 'TENANT', actions: [
    { action: 'VIEW', roles: ALL_ROLES },
    { action: 'UPDATE', roles: TENANT_ADMIN_ONLY },
  ] },
  { resource: 'WAREHOUSE', actions: [
    { action: 'VIEW', roles: INVENTORY_STAFF },
    { action: 'CREATE', roles: MANAGEMENT },
    { action: 'UPDATE', roles: MANAGEMENT },
    { action: 'APPROVE', roles: INVENTORY_STAFF }, // receive/dispatch/adjust stock moves
  ] },
  { resource: 'STOCK_TRANSFER', actions: [
    { action: 'VIEW', roles: INVENTORY_STAFF },
    { action: 'CREATE', roles: INVENTORY_STAFF },
    { action: 'UPDATE', roles: INVENTORY_STAFF }, // cancel/dispatch/receive - state transitions, not an approval gate
    { action: 'APPROVE', roles: MANAGEMENT },
  ] },
  { resource: 'SALE', actions: [
    { action: 'VIEW', roles: SALES_STAFF },
    { action: 'CREATE', roles: SALES_STAFF },
    { action: 'REVERSE', roles: MANAGEMENT },
  ] },
  { resource: 'PURCHASE', actions: [
    { action: 'VIEW', roles: INVENTORY_STAFF },
    { action: 'CREATE', roles: INVENTORY_STAFF },
    { action: 'REVERSE', roles: MANAGEMENT },
  ] },
  // Phase 1.13: a PARTIAL, line-item-level sales return - distinct from
  // SALE's own REVERSE (Phase 1.8's whole-sale reversal, unchanged). Roles
  // mirror SALE's exactly, since it's the same staff who'd create the
  // original sale who'd process a return against it.
  { resource: 'SALES_RETURN', actions: [
    { action: 'VIEW', roles: SALES_STAFF },
    { action: 'CREATE', roles: SALES_STAFF },
    { action: 'REVERSE', roles: MANAGEMENT },
  ] },
  // Mirrors PURCHASE's roles exactly, for the same reason.
  { resource: 'PURCHASE_RETURN', actions: [
    { action: 'VIEW', roles: INVENTORY_STAFF },
    { action: 'CREATE', roles: INVENTORY_STAFF },
    { action: 'REVERSE', roles: MANAGEMENT },
  ] },
  // A financial document (mirrors EXPENSE's role choice) - cancellation and
  // refund both release/reverse real financial effect, so both are
  // MANAGEMENT-only, matching every other REVERSE-class action in this
  // catalog.
  { resource: 'CREDIT_NOTE', actions: [
    { action: 'VIEW', roles: FINANCE_STAFF },
    { action: 'CREATE', roles: FINANCE_STAFF },
    { action: 'REVERSE', roles: MANAGEMENT },
    { action: 'REFUND', roles: MANAGEMENT },
  ] },
  { resource: 'DEBIT_NOTE', actions: [
    { action: 'VIEW', roles: FINANCE_STAFF },
    { action: 'CREATE', roles: FINANCE_STAFF },
    { action: 'REVERSE', roles: MANAGEMENT },
    { action: 'REFUND', roles: MANAGEMENT },
  ] },
  { resource: 'PAYMENT', actions: [
    { action: 'VIEW', roles: FINANCE_STAFF },
    // Phase 1.11: whoever can create/view the Customer/Supplier a standalone
    // payment attaches to (CONTACTS_STAFF) can record one against them -
    // mirrors that same role group exactly, rather than a new bespoke list.
    { action: 'CREATE', roles: CONTACTS_STAFF },
    // Reversal is a privileged operation, matching SALE:REVERSE and
    // PURCHASE:REVERSE's identical MANAGEMENT-only precedent.
    { action: 'REVERSE', roles: MANAGEMENT },
  ] },
  { resource: 'EXPENSE', actions: [
    { action: 'VIEW', roles: FINANCE_STAFF },
    { action: 'CREATE', roles: FINANCE_STAFF },
    // Phase 1.12: closes a real gap - PATCH /:id previously ran on a
    // legacy requireRole check with no matching catalog entry at all.
    { action: 'UPDATE', roles: FINANCE_STAFF },
    // Reversal is a privileged operation, matching SALE:REVERSE/
    // PURCHASE:REVERSE/PAYMENT:REVERSE's identical MANAGEMENT-only
    // precedent exactly.
    { action: 'REVERSE', roles: MANAGEMENT },
    // Pre-existing, still unused - no approve/reject workflow exists (see
    // this phase's report, Expense Lifecycle) - left as-is, not removed,
    // since a future phase may build the workflow this already anticipates.
    { action: 'APPROVE', roles: MANAGEMENT },
  ] },
  // Phase 1.14: Customer Quotations. VIEW/CREATE/UPDATE mirror SALE's own
  // SALES_STAFF role group exactly (the same staff who create a Sale would
  // draft/edit a quotation for one). APPROVE is reused for recording the
  // customer's ACCEPTANCE of a sent quotation (Sent -> Accepted) and REVERSE
  // for recording REJECTION or CANCELLATION (Sent -> Rejected, Draft/Sent ->
  // Cancelled) - both fixed PermissionAction enum values already used this
  // way elsewhere in this catalog, not new ad-hoc actions. Converting an
  // accepted quotation into a Sales Order is gated by SALES_ORDER:CREATE
  // below (the permission for the document actually being created), not a
  // separate QUOTATION:CONVERT action.
  // Phase 1.15: the Activity Log is a sensitive, cross-user, historical
  // record (every user's actions, not just the viewer's own) - restricted
  // to MANAGEMENT only, mirroring every other privileged/REVERSE-class
  // resource's precedent in this catalog. No CREATE/UPDATE/DELETE action
  // exists for it at all (append-only, written exclusively via the
  // existing logAudit() service, never through this or any other route).
  { resource: 'AUDIT_LOG', actions: [
    { action: 'VIEW', roles: MANAGEMENT },
  ] },
  { resource: 'QUOTATION', actions: [
    { action: 'VIEW', roles: SALES_STAFF },
    { action: 'CREATE', roles: SALES_STAFF },
    { action: 'UPDATE', roles: SALES_STAFF },
    { action: 'APPROVE', roles: SALES_STAFF },
    { action: 'REVERSE', roles: SALES_STAFF },
  ] },
  // Phase 1.14: Sales Orders. APPROVE is reused for CONFIRMING a draft order
  // (Draft -> Confirmed); REVERSE for CANCELLING one, gated to MANAGEMENT
  // (mirroring SALES_RETURN/PURCHASE_RETURN's identical "undoing a
  // real commitment is a privileged action" precedent) rather than
  // SALES_STAFF. Fulfilling/converting an order into a Sale is gated by
  // SALE:CREATE (the permission for the document actually being created),
  // not a separate SALES_ORDER:CONVERT action.
  { resource: 'SALES_ORDER', actions: [
    { action: 'VIEW', roles: SALES_STAFF },
    { action: 'CREATE', roles: SALES_STAFF },
    { action: 'UPDATE', roles: SALES_STAFF },
    { action: 'APPROVE', roles: SALES_STAFF },
    { action: 'REVERSE', roles: MANAGEMENT },
  ] },
  { resource: 'PURCHASE_REQUEST', actions: [
    { action: 'VIEW', roles: INVENTORY_STAFF },
    { action: 'CREATE', roles: INVENTORY_STAFF },
    // Phase 4.3: editing/submitting a DRAFT request - same role band as creating one.
    { action: 'UPDATE', roles: INVENTORY_STAFF },
    { action: 'APPROVE', roles: MANAGEMENT },
  ] },
  { resource: 'PURCHASE_ORDER', actions: [
    { action: 'VIEW', roles: INVENTORY_STAFF },
    { action: 'CREATE', roles: INVENTORY_STAFF },
    // Phase 4.3: closing/cancelling an RFQ reuses RFQ:UPDATE already below; this
    // UPDATE is for editing a PO's own notes field (never quantities/pricing
    // once created - those are locked by the approval/receiving workflow).
    { action: 'UPDATE', roles: INVENTORY_STAFF },
    { action: 'APPROVE', roles: MANAGEMENT },
  ] },
  { resource: 'GOODS_RECEIPT', actions: [
    { action: 'VIEW', roles: INVENTORY_STAFF },
    { action: 'CREATE', roles: INVENTORY_STAFF },
  ] },
  { resource: 'RFQ', actions: [
    { action: 'VIEW', roles: INVENTORY_STAFF },
    { action: 'CREATE', roles: INVENTORY_STAFF },
    { action: 'UPDATE', roles: INVENTORY_STAFF },
  ] },
  { resource: 'JOURNAL', actions: [
    { action: 'VIEW', roles: FINANCE_STAFF },
    { action: 'CREATE', roles: MANAGEMENT },
    // Phase 2.1: draft workflow. UPDATE = edit/cancel a DRAFT; APPROVE = post a
    // draft into the ledger; REVERSE = reverse (void) a posted manual entry -
    // all MANAGEMENT, matching what the pre-existing POST / and /void already
    // required via requireRole(...MANAGEMENT).
    { action: 'UPDATE', roles: MANAGEMENT },
    { action: 'APPROVE', roles: MANAGEMENT },
    { action: 'REVERSE', roles: MANAGEMENT },
  ] },
  // Phase 2.1: Chart of Accounts. Roles mirror exactly what accounts.routes.js
  // enforced via requireRole before this phase (FINANCE_STAFF read, MANAGEMENT
  // write) - the routes now go through requirePermission instead.
  { resource: 'ACCOUNT', actions: [
    { action: 'VIEW', roles: FINANCE_STAFF },
    { action: 'CREATE', roles: MANAGEMENT },
    { action: 'UPDATE', roles: MANAGEMENT },
    { action: 'DELETE', roles: MANAGEMENT },
  ] },
  // Phase 2.1: opening balances are a one-time, high-impact posting - creation
  // is TENANT_ADMIN-only; viewing whether one exists follows FINANCE_STAFF.
  { resource: 'OPENING_BALANCE', actions: [
    { action: 'VIEW', roles: FINANCE_STAFF },
    { action: 'CREATE', roles: TENANT_ADMIN_ONLY },
  ] },
  { resource: 'REPORT', actions: [
    { action: 'VIEW', roles: FINANCE_STAFF },
    { action: 'EXPORT', roles: FINANCE_STAFF },
  ] },
  { resource: 'USER', actions: [
    { action: 'VIEW', roles: TENANT_ADMIN_ONLY },
    { action: 'CREATE', roles: TENANT_ADMIN_ONLY },
    { action: 'UPDATE', roles: TENANT_ADMIN_ONLY },
    { action: 'DELETE', roles: TENANT_ADMIN_ONLY },
  ] },
  { resource: 'PATIENT', actions: [
    { action: 'VIEW', roles: CLINICAL_STAFF },
    { action: 'CREATE', roles: CLINICAL_STAFF },
    { action: 'UPDATE', roles: CLINICAL_STAFF },
  ] },
  { resource: 'APPOINTMENT', actions: [
    { action: 'VIEW', roles: CLINICAL_STAFF },
    { action: 'CREATE', roles: CLINICAL_STAFF },
    { action: 'UPDATE', roles: CLINICAL_STAFF },
  ] },
  { resource: 'EXAMINATION', actions: [
    { action: 'VIEW', roles: CLINICAL_STAFF },
    { action: 'CREATE', roles: CLINICAL_STAFF },
  ] },
  { resource: 'PRESCRIPTION', actions: [
    { action: 'VIEW', roles: CLINICAL_STAFF },
    { action: 'CREATE', roles: CLINICAL_STAFF },
  ] },
  { resource: 'OPTICAL_ORDER', actions: [
    { action: 'VIEW', roles: FRONT_DESK },
    { action: 'CREATE', roles: FRONT_DESK },
    { action: 'UPDATE', roles: FRONT_DESK },
  ] },
  { resource: 'COMMUNICATION', actions: [
    { action: 'VIEW', roles: COMMUNICATION_STAFF },
    { action: 'CREATE', roles: COMMUNICATION_STAFF },
  ] },
  // Phase 0.5: the module registry/activation resource - lets any signed-in
  // staff member see which modules exist and are enabled (useful for
  // nav-gating and a future settings screen), while only a TENANT_ADMIN can
  // actually toggle an industry module on/off for the tenant.
  { resource: 'MODULE', actions: [
    { action: 'VIEW', roles: ALL_ROLES },
    { action: 'UPDATE', roles: TENANT_ADMIN_ONLY },
  ] },
];

module.exports = { PERMISSION_CATALOG };
