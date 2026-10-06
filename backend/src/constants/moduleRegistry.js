// Phase 0.5: the single source of truth for Core / Universal / Industry
// module classification, per docs/phase0-5-module-architecture-verification-report.md.
//
// This registry documents the architecture AND drives real runtime behavior:
// - `type: 'INDUSTRY'` modules are gated by requireModule() (see
//   middleware/moduleAccess.js) against Tenant.enabledIndustryPacks - a
//   tenant that has disabled a module genuinely cannot reach its routes.
// - `type: 'CORE'` and `type: 'UNIVERSAL'` modules are never gated; they are
//   always available to every tenant, exactly as today.
//
// Adding a genuinely new industry module (e.g. a future Restaurant module)
// means: add an entry here with `industryPackKey` set to the string a tenant
// will carry in `enabledIndustryPacks`, mount its routes behind
// requireModule('THAT_KEY'), and it is fully wired into activation,
// introspection (GET /api/modules), and nav-gating with no other code
// changes required.
//
// `implemented: false` entries are placeholders reflecting the Phase 0.5
// target architecture's full industry list - no code exists for them yet,
// and GET /api/modules reports them as such rather than pretending they work.

const CORE_MODULES = [
  {
    id: 'TENANT_COMPANY_BRANCH',
    name: 'Tenant / Company / Branch',
    type: 'CORE',
    description: 'Multi-tenant ownership hierarchy: Tenant -> Company -> Branch -> Warehouse.',
    dependencies: [],
    dbEntities: ['Tenant', 'Company', 'Branch', 'Warehouse'],
    routePrefixes: ['/api/branches', '/api/companies', '/api/warehouses'],
  },
  {
    id: 'USERS_RBAC',
    name: 'Users / RBAC',
    type: 'CORE',
    description: 'Staff accounts, roles, and the centralized Permission/RolePermission authorization system (Phase 0.4).',
    dependencies: [],
    dbEntities: ['User', 'Permission', 'RolePermission', 'UserBranchAccess', 'UserCompanyAccess', 'UserWarehouseAccess'],
    routePrefixes: ['/api/users', '/api/permissions', '/api/auth'],
  },
  {
    id: 'PRODUCTS',
    name: 'Products / Services',
    type: 'CORE',
    description: 'Universal product/service catalog. Industry-specific attributes (Optical, Medicine) are 1:1 extension tables, never fields required by Core (Phase 0.2).',
    dependencies: [],
    dbEntities: ['Product', 'Category', 'ProductVariant'],
    routePrefixes: ['/api/products', '/api/categories'],
  },
  {
    id: 'CUSTOMERS',
    name: 'Customers',
    type: 'CORE',
    description: 'Universal customer/contact records. An industry module may extend a Customer (e.g. a Patient profile) but never duplicates its identity.',
    dependencies: [],
    dbEntities: ['Customer'],
    routePrefixes: ['/api/customers'],
  },
  {
    id: 'SUPPLIERS',
    name: 'Suppliers',
    type: 'CORE',
    description: 'Universal supplier/vendor records.',
    dependencies: [],
    dbEntities: ['Supplier'],
    routePrefixes: ['/api/suppliers'],
  },
  {
    id: 'SALES',
    name: 'Sales',
    type: 'CORE',
    description: 'Point-of-sale transactions against the universal Product catalog.',
    dependencies: ['PRODUCTS', 'CUSTOMERS'],
    dbEntities: ['Sale', 'SaleItem'],
    routePrefixes: ['/api/sales'],
  },
  {
    id: 'PURCHASES',
    name: 'Purchases',
    type: 'CORE',
    description: 'Supplier purchase transactions against the universal Product catalog.',
    dependencies: ['PRODUCTS', 'SUPPLIERS'],
    dbEntities: ['Purchase', 'PurchaseItem'],
    routePrefixes: ['/api/purchases'],
  },
  {
    id: 'INVENTORY',
    name: 'Inventory',
    type: 'CORE',
    description: 'Stock levels and movement history for the universal Product catalog.',
    dependencies: ['PRODUCTS'],
    dbEntities: ['InventoryTransaction', 'WarehouseStock'],
    routePrefixes: ['/api/inventory'],
  },
  {
    id: 'PAYMENTS',
    name: 'Payments',
    type: 'CORE',
    description: 'Universal money-in/money-out ledger of payments against Sales, Purchases, Expenses, and any industry module (e.g. Optical Orders).',
    dependencies: [],
    dbEntities: ['Payment'],
    routePrefixes: ['/api/payments'],
  },
  {
    id: 'EXPENSES',
    name: 'Expenses',
    type: 'CORE',
    description: 'Universal business expense tracking.',
    dependencies: [],
    dbEntities: ['Expense', 'ExpenseCategory'],
    routePrefixes: ['/api/expenses', '/api/expense-categories'],
  },
];

const UNIVERSAL_MODULES = [
  {
    id: 'ACCOUNTING',
    name: 'Accounting',
    type: 'UNIVERSAL',
    description: 'Double-entry ledger, Chart of Accounts, and financial statements, derived from Core + any enabled module\'s transactions.',
    dependencies: ['SALES', 'PURCHASES', 'EXPENSES', 'PAYMENTS'],
    dbEntities: ['Account', 'JournalEntry', 'JournalLine', 'AccountingPeriod', 'TaxRate'],
    routePrefixes: ['/api/accounting'],
  },
  {
    id: 'PROCUREMENT',
    name: 'Procurement',
    type: 'UNIVERSAL',
    description: 'Purchase Request -> RFQ -> Quotation -> Purchase Order -> Goods Receipt workflow.',
    dependencies: ['PRODUCTS', 'SUPPLIERS', 'PURCHASES'],
    dbEntities: ['PurchaseRequest', 'RFQ', 'SupplierQuotation', 'PurchaseOrder', 'GoodsReceipt'],
    routePrefixes: ['/api/procurement'],
  },
  {
    id: 'WAREHOUSES',
    name: 'Warehouses / Stock Transfers',
    type: 'UNIVERSAL',
    description: 'Multi-location stock and inter-warehouse transfers.',
    dependencies: ['INVENTORY', 'TENANT_COMPANY_BRANCH'],
    dbEntities: ['Warehouse', 'WarehouseStock', 'StockTransfer'],
    routePrefixes: ['/api/warehouses', '/api/stock-transfers'],
  },
  {
    id: 'REPORTS',
    name: 'Reports',
    type: 'UNIVERSAL',
    description: 'Cross-cutting reporting surface. Aggregates whichever Core/Universal/Industry data is enabled for the tenant.',
    dependencies: [],
    dbEntities: [],
    routePrefixes: ['/api/reports', '/api/accounting/reports', '/api/clinical-reports', '/api/communication/reports'],
  },
  {
    id: 'DASHBOARD',
    name: 'Dashboard / Command Center',
    type: 'UNIVERSAL',
    description: 'Cross-cutting operational dashboard. Aggregates whichever Core/Universal/Industry data is enabled for the tenant.',
    dependencies: [],
    dbEntities: [],
    routePrefixes: ['/api/dashboard'],
  },
  {
    id: 'COMMUNICATION',
    name: 'Communication / Automation',
    type: 'UNIVERSAL',
    description: 'WhatsApp/in-app messaging, templates, and event-driven automation rules.',
    dependencies: ['CUSTOMERS'],
    dbEntities: ['CommunicationConfig', 'MessageTemplate', 'Message', 'AutomationRule', 'AutomationExecution', 'Notification'],
    routePrefixes: ['/api/communication', '/api/automation', '/api/notifications'],
  },
  {
    id: 'AI',
    name: 'AI Business Intelligence',
    type: 'UNIVERSAL',
    description: 'Deterministic/AI-assisted insights, forecasts, and a business assistant, grounded in whichever Core/Universal/Industry data is enabled.',
    dependencies: [],
    dbEntities: ['AiConfig', 'AiConversation', 'AiMessage', 'AiInsight', 'AiForecast', 'AiUsageLog', 'AiFeedback'],
    routePrefixes: ['/api/ai'],
  },
];

const INDUSTRY_MODULES = [
  {
    id: 'OPTICAL',
    name: 'Optical / Eye Clinic',
    type: 'INDUSTRY',
    implemented: true,
    industryPackKey: 'OPTICAL',
    description:
      'Optical retail (frame/lens orders) and the attached eye-clinic workflow (patients, doctors, appointments, examinations, prescriptions, labs). ' +
      'These two are registered as one module because they are one inseparable vertical in the current implementation - an OpticalOrder can ' +
      'reference a Patient/ClinicalPrescription, and splitting "retail optical" from "clinical eye-care" into two independently-toggleable ' +
      'modules would require decoupling that link, which is out of scope for this phase (see the Phase 0.5 report\'s remaining conditions).',
    dependencies: ['PRODUCTS', 'CUSTOMERS', 'SALES', 'PAYMENTS'],
    dbEntities: ['OpticalOrder', 'Prescription', 'Patient', 'Doctor', 'Appointment', 'Examination', 'ClinicalPrescription', 'Lab'],
    routePrefixes: [
      '/api/optical-orders', '/api/patients', '/api/doctors', '/api/appointments',
      '/api/examinations', '/api/clinical-prescriptions', '/api/labs', '/api/clinical-reports',
    ],
  },
  {
    id: 'MEDICINE',
    name: 'Medical Store / Pharmacy',
    type: 'INDUSTRY',
    // Phase 0.2 already added the ProductMedicineAttributes extension table
    // and Product.type=MEDICINE, but no dedicated Pharmacy route module
    // exists yet - there is nothing to gate behind requireModule() beyond
    // the one Core-reports "Medicine Expiry Report" endpoint, which is
    // gated in this phase. A future phase can build a real Pharmacy module
    // (batch/lot tracking, drug-interaction data, etc.) behind this same key.
    implemented: true,
    industryPackKey: 'MEDICINE',
    description: 'Pharmacy/medicine-specific product attributes (batch number, expiry date) and the Medicine Expiry Report.',
    dependencies: ['PRODUCTS'],
    dbEntities: ['ProductMedicineAttributes'],
    routePrefixes: [],
  },
  // Target-architecture placeholders (Section 1 of the Phase 0.5 spec).
  // Not implemented: no schema, no routes, no UI. Listed here only so the
  // registry - and GET /api/modules - accurately reflects the intended
  // final module set without fabricating functionality that doesn't exist.
  { id: 'RETAIL', name: 'Retail', type: 'INDUSTRY', implemented: false, industryPackKey: 'RETAIL', description: 'Not yet implemented.', dependencies: ['PRODUCTS', 'SALES'], dbEntities: [], routePrefixes: [] },
  { id: 'WHOLESALE_DISTRIBUTION', name: 'Wholesale / Distribution', type: 'INDUSTRY', implemented: false, industryPackKey: 'WHOLESALE_DISTRIBUTION', description: 'Not yet implemented.', dependencies: ['PRODUCTS', 'SALES', 'PURCHASES'], dbEntities: [], routePrefixes: [] },
  { id: 'RESTAURANT_FOOD', name: 'Restaurant / Food', type: 'INDUSTRY', implemented: false, industryPackKey: 'RESTAURANT_FOOD', description: 'Not yet implemented.', dependencies: ['PRODUCTS', 'SALES'], dbEntities: [], routePrefixes: [] },
  { id: 'MANUFACTURING', name: 'Manufacturing', type: 'INDUSTRY', implemented: false, industryPackKey: 'MANUFACTURING', description: 'Not yet implemented.', dependencies: ['PRODUCTS', 'INVENTORY', 'PURCHASES'], dbEntities: [], routePrefixes: [] },
  { id: 'SERVICE', name: 'Service', type: 'INDUSTRY', implemented: false, industryPackKey: 'SERVICE', description: 'Not yet implemented.', dependencies: ['PRODUCTS', 'SALES'], dbEntities: [], routePrefixes: [] },
];

const MODULE_REGISTRY = [...CORE_MODULES, ...UNIVERSAL_MODULES, ...INDUSTRY_MODULES];
const MODULE_REGISTRY_BY_ID = new Map(MODULE_REGISTRY.map((m) => [m.id, m]));

module.exports = { MODULE_REGISTRY, MODULE_REGISTRY_BY_ID, CORE_MODULES, UNIVERSAL_MODULES, INDUSTRY_MODULES };
