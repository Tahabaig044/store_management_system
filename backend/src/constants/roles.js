// Central role groupings used by route-level requireRole() checks.
// Keeping these as named groups (rather than repeating role lists at every
// route) is the single source of truth for "who can do what" server-side.

const ALL_ROLES = [
  'SUPER_ADMIN',
  'TENANT_ADMIN',
  'MANAGER',
  'CASHIER',
  'STORE_KEEPER',
  'RECEPTIONIST',
  'ACCOUNTANT',
  'DOCTOR',
];

const TENANT_ADMIN_ONLY = ['TENANT_ADMIN'];
const MANAGEMENT = ['TENANT_ADMIN', 'MANAGER'];
const INVENTORY_STAFF = ['TENANT_ADMIN', 'MANAGER', 'STORE_KEEPER'];
const SALES_STAFF = ['TENANT_ADMIN', 'MANAGER', 'CASHIER'];
const FRONT_DESK = ['TENANT_ADMIN', 'MANAGER', 'RECEPTIONIST'];
const FINANCE_STAFF = ['TENANT_ADMIN', 'MANAGER', 'ACCOUNTANT'];
// Contact records are read/used across almost every desk in the shop.
const CONTACTS_STAFF = ['TENANT_ADMIN', 'MANAGER', 'CASHIER', 'STORE_KEEPER', 'RECEPTIONIST', 'ACCOUNTANT'];
// Phase 7: roles that may touch clinical records (examinations, prescriptions,
// appointments) - deliberately excludes CASHIER/STORE_KEEPER/ACCOUNTANT, who
// have no business reason to see clinical detail even though they can see
// the same patient as an ordinary Customer.
const CLINICAL_STAFF = ['TENANT_ADMIN', 'MANAGER', 'DOCTOR', 'RECEPTIONIST'];
// Phase 8: who may view/resend customer communications and see the
// Communication Center. Message *bodies* for clinical template types are
// further redacted for anyone outside CLINICAL_STAFF, even within this group.
const COMMUNICATION_STAFF = ['TENANT_ADMIN', 'MANAGER', 'RECEPTIONIST', 'ACCOUNTANT'];

module.exports = {
  ALL_ROLES,
  TENANT_ADMIN_ONLY,
  MANAGEMENT,
  INVENTORY_STAFF,
  SALES_STAFF,
  FRONT_DESK,
  FINANCE_STAFF,
  CONTACTS_STAFF,
  CLINICAL_STAFF,
  COMMUNICATION_STAFF,
};
