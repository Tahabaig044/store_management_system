# Phase 0.1 — Frontend UI Map (Evidence-Based Audit)

Scope: `frontend/src/` as of the current `main` branch working tree. Pure inventory/documentation — no UI was changed to produce this document.

Sources inspected: `frontend/src/App.jsx` (router), `frontend/src/components/Layout.jsx` (sidebar/nav), `frontend/src/components/ProtectedRoute.jsx` (role guard), every file under `frontend/src/pages/**`, `frontend/src/components/**`, `frontend/src/offline/**` (offline-first sync layer), `frontend/src/index.css` (theme tokens), and `backend/src/modules/**` (to name backend modules).

---

## 1. Page Inventory

29 routed pages/screens (27 under the staff `Layout`/`ProtectedRoute` shell + `Login`/`RegisterTenant`), plus 2 customer-portal screens under a separate `/portal/*` shell. 31 screens total.

| Page/Route | Purpose | Backend module(s) called | Role visibility (nav + route guard) | Classification | Notes |
|---|---|---|---|---|---|
| `/login` — `pages/auth/Login.jsx` | Staff sign-in | `auth` (`POST /auth/login` via `AuthContext`) | Public (unauthenticated) | Universal | Hard-codes "AK VisionFlow" heading (see §4) |
| `/register` — `pages/auth/RegisterTenant.jsx` | Self-serve tenant/business sign-up | `auth` (tenant registration) | Public | Universal | Hard-codes "AK VisionFlow" heading; fields "Business Name" are generic, not optical-specific |
| `/` — `pages/dashboard/Dashboard.jsx` | Legacy/simple daily-overview dashboard (today's sales, month sales/purchases, gross profit est., inventory value, customer/supplier counts, low stock, expiring medicines) | `dashboard` (`GET /dashboard`) | All authenticated roles (`roles: null` in nav) | Module-specific (retail/inventory metrics) | Coexists with the newer Command Center; "Expiring Medicines" widget is a pharmacy/medicine-vertical concept baked into a generic dashboard |
| `/command-center` — `pages/dashboard/CommandCenter.jsx` | Advanced, filterable, customizable BI dashboard (KPIs, trends, top products, stock alerts, optical jobs, customers, receivables/payables, branch/staff performance) with a per-user saved widget layout | `dashboard` (`GET/PUT /dashboard/command-center`, `/dashboard/preferences`), plus `branches`, `categories`, `products`, `suppliers`, `customers` for filter option lists; embeds `ai` insights block from the `ai` module | `TENANT_ADMIN`, `MANAGER` | Module-specific / has Universal bones | Widget framework (hide/reorder/persist) is itself reusable/Universal; the built-in `opticalJobs` widget (Pending/Ready/Delayed, `/optical-orders?status=...`) and "Expiring Medicines" box are hard industry-specific widgets with no config to swap them out |
| `/pos` — `pages/sales/Pos.jsx` | Point-of-sale checkout screen (cart, payment methods, offline-capable) | `sales` (via offline outbox `apiPath: '/sales'`, see `offline/syncEngine.js`); reads live cached `products`/`customers` from IndexedDB (`offline/useOfflineData.js`) | `TENANT_ADMIN`, `MANAGER`, `CASHIER` | Universal (retail POS pattern) | Only page fully on the offline-first Dexie/outbox path along with parts of Expenses/Customers/Suppliers |
| `/sales-history` — `pages/sales/SalesHistory.jsx` | List/search past sales, reverse a sale | `sales` (`GET /sales`, `POST /sales/:id/reverse`) | `TENANT_ADMIN`, `MANAGER`, `CASHIER` | Universal | — |
| `/products` — `pages/products/Products.jsx` | Product/inventory catalog CRUD, stock adjustment | `products` (`GET/POST/PATCH/DELETE /products`, `/products/:id/adjust-stock`), `categories` | No role restriction in route (`<Route path="/products" element={<Products />} />`); nav item restricted to `TENANT_ADMIN, MANAGER, STORE_KEEPER, CASHIER, RECEPTIONIST, ACCOUNTANT` | Module-specific with Industry-specific fields | Route itself has **no** `ProtectedRoute roles` wrapper (inconsistent with nav-level restriction — any authenticated role can hit the URL directly); product Type select hard-codes `FRAME` / `LENS` values (see §4) |
| `/categories` — `pages/categories/Categories.jsx` | Product category CRUD | `categories` | `TENANT_ADMIN, MANAGER, CASHIER, STORE_KEEPER, RECEPTIONIST, ACCOUNTANT` | Universal | Category name `<datalist>` suggestions are generic retail (not read from code, but likely includes optical presets — see §4 follow-up) |
| `/purchases` — `pages/purchases/Purchases.jsx` | Supplier purchase orders: create, receive, pay | `purchases` (`GET /purchases`, `POST /purchases/:id/receive`, `/purchases/:id/pay`) | `TENANT_ADMIN, MANAGER, STORE_KEEPER` | Universal | — |
| `/customers` — `pages/customers/Customers.jsx` | Customer directory, history, ledger | `customers` (`GET/PATCH /customers`, `/customers/:id/history`) | No route guard (`roles: null`); nav item also unrestricted | Universal | — |
| `/suppliers` — `pages/suppliers/Suppliers.jsx` | Supplier directory, ledger | `suppliers` | No route guard; nav unrestricted | Universal | — |
| `/branches` — `pages/branches/Branches.jsx` | Multi-branch/location management, open/close branch | `branches` | No route guard; nav unrestricted; in-page `canManage` limited to `TENANT_ADMIN` | Universal | — |
| `/optical-orders` — `pages/opticalOrders/OpticalOrders.jsx` | Create/track optical lab jobs (frame/lens description, prescription, status, payment) | `opticalOrders` (`GET/PATCH /optical-orders`, `/optical-orders/:id/pay`) | `TENANT_ADMIN, MANAGER, RECEPTIONIST` | **Industry-specific** | Core optical-vertical workflow; statuses `PENDING/IN_LAB/READY/DELIVERED/CANCELLED` are lab-specific and hard-coded in JSX (see §4) |
| `/expenses` — `pages/expenses/Expenses.jsx` | Expense entry & categorization | `expenses`, `expenseCategories` (`POST /expense-categories`); uses offline live-cached expense categories | `TENANT_ADMIN, MANAGER, ACCOUNTANT` | Universal | — |
| `/reports` — `pages/reports/Reports.jsx` | Tabbed report viewer + CSV export/print (Daily/Monthly Sales, Inventory, Stock Movement, Expenses, P&L, Optical Orders, Medicine Expiry) | `reports` (`GET /reports/:key`) | `TENANT_ADMIN, MANAGER, ACCOUNTANT` | Mixed: Universal shell, **Industry-specific** report keys | "Optical Orders" and "Medicine Expiry" report tabs are hard-coded verticals sitting alongside generic Sales/Inventory/Expenses/P&L reports |
| `/users` — `pages/users/Users.jsx` | Staff user management (create, activate/deactivate, assign role) | `users` | `TENANT_ADMIN` only | Universal | Role list hard-codes clinic/retail hybrid roles: `MANAGER, CASHIER, STORE_KEEPER, RECEPTIONIST, ACCOUNTANT, DOCTOR, TENANT_ADMIN` — `DOCTOR`/`RECEPTIONIST` are clinic-specific role names baked into a Universal user-admin screen |
| `/accounting` — `pages/accounting/Accounting.jsx` | Chart of Accounts, Journal, Trial Balance, P&L, Balance Sheet, AR/AP Aging (double-entry ledger UI) | `accounting` (`GET /accounting/accounts`, `/journal`, `/reports/*`) | `TENANT_ADMIN, MANAGER, ACCOUNTANT` | Universal | Well-factored, fully generic financial module |
| `/procurement` — `pages/procurement/Procurement.jsx` | Purchase requests → purchase orders → goods receipts workflow | `procurement` (`purchase-requests`, `purchase-orders`, `goods-receipts`), `products`, `suppliers` | `TENANT_ADMIN, MANAGER, STORE_KEEPER` | Universal | Separate from/duplicate-ish with simpler `Purchases` module — two purchasing paths coexist |
| `/warehouses` — `pages/warehouses/Warehouses.jsx` | Warehouse/location CRUD, per-warehouse stock view, stock move in/out | `warehouses`, `branches` | `TENANT_ADMIN, MANAGER, STORE_KEEPER` | Universal | Explicitly optional (comment: "single-branch shop... nothing here is required setup") |
| `/stock-transfers` — `pages/warehouses/StockTransfers.jsx` | Transfer stock between warehouses, approve/reject | `warehouses` (`/stock-transfers`), `products` | `TENANT_ADMIN, MANAGER, STORE_KEEPER` | Universal | — |
| `/patients` — `pages/patients/Patients.jsx` | Patient directory + "360" clinical view: examinations, prescriptions, linked optical orders | `clinical` (`GET /patients`, `/patients/:id/360`, `POST /examinations`, `/clinical-prescriptions`), `opticalOrders` (`POST /optical-orders`) | `TENANT_ADMIN, MANAGER, DOCTOR, RECEPTIONIST` | **Industry-specific** | Deeply eye-clinic-specific: OD/OS/PD prescription fields, "Examination", "Diagnosis" all hard-coded in JSX, not config-driven |
| `/appointments` — `pages/clinical/Appointments.jsx` | Appointment queue/booking with status workflow | `clinical` (`GET /appointments`, `/appointments/today`, status transitions) | `TENANT_ADMIN, MANAGER, DOCTOR, RECEPTIONIST` | Module-specific (scheduling is common; content is clinic-flavored) | Status flow `SCHEDULED→CONFIRMED→ARRIVED→IN_PROGRESS→COMPLETED`/`NO_SHOW`/`CANCELLED` hard-coded; reusable pattern for any appointment-based vertical (salons, clinics) but not abstracted as such |
| `/doctors` — `pages/clinical/Doctors.jsx` | Doctor directory (name, specialty, designation) | `clinical` (`/doctors`) | `TENANT_ADMIN, MANAGER, DOCTOR, RECEPTIONIST` | **Industry-specific** | "Doctor"/"Specialty" concept is clinic-only; would need to become a generic "Provider/Staff resource" concept for other verticals |
| `/communication` — `pages/communication/CommunicationCenter.jsx` | Send/track customer messages (SMS/WhatsApp/etc.), templates | `communication` (`/communication/messages`, `/communication/templates`), `customers` | `TENANT_ADMIN, MANAGER, RECEPTIONIST, ACCOUNTANT` | Universal | — |
| `/automation-rules` — `pages/communication/AutomationRules.jsx` | Toggle/configure automated communication rules (delay, enabled) | `communication` (`/communication/automation-rules`) | `TENANT_ADMIN, MANAGER, RECEPTIONIST, ACCOUNTANT` | Universal | — |
| `/ai-assistant` — `pages/ai/AiAssistant.jsx` | Conversational Q&A assistant over business data | `ai` (`/ai/assistant/*`) | `TENANT_ADMIN, MANAGER` | Universal | — |
| `/recommendations` — `pages/ai/RecommendationCenter.jsx` | AI-generated risk/opportunity/anomaly insights feed | `ai` (`/ai/insights*`) | `TENANT_ADMIN, MANAGER` | Universal | — |
| `/portal/login` — `pages/portal/PortalLogin.jsx` | Customer-facing OTP login (separate auth flow/token) | `portal` (OTP request/verify) | Public (customer, not staff) | Universal | Tenant selected via `?tenant=` query param — no subdomain-per-tenant support yet |
| `/portal/*` — `pages/portal/PortalDashboard.jsx` | Customer self-service portal: profile, optical orders, invoices, appointments, prescriptions, outstanding balance, appointment request, follow-up message, comms opt-out | `portal` (`/portal/me`, `/portal/optical-orders`, `/portal/invoices`, `/portal/appointments`, `/portal/prescriptions`, `/portal/outstanding-balance`, `/portal/appointments/request`, `/portal/follow-up`, `/portal/communication-preferences`) | Authenticated portal customer only | **Industry-specific** | Tabs hard-code `['Overview', 'Optical Orders', 'Invoices', 'Appointments', 'Prescriptions']` — entirely optical/clinic-vocabulary, not configurable per tenant/industry |

### Not routed in `App.jsx` (present in `pages/` but currently dead code / unreachable)
None found — every file under `pages/` that exports a default component is wired into `App.jsx`.

---

## 2. Navigation / Role Visibility Map

Source: `frontend/src/components/Layout.jsx` `NAV_ITEMS` (drives sidebar visibility) cross-checked against `frontend/src/App.jsx` `ProtectedRoute roles=[...]` (drives actual access control). `ProtectedRoute` (`frontend/src/components/ProtectedRoute.jsx`) redirects to `/` if `roles` is set and the user's role isn't in it; a `null` roles list means "any authenticated user."

| Nav label | Route | Roles (nav AND route guard, where both exist) | Guard consistency |
|---|---|---|---|
| Dashboard | `/` | any authenticated | Matches (no guard either place) |
| Command Center | `/command-center` | TENANT_ADMIN, MANAGER | Matches |
| POS / Sales | `/pos` | TENANT_ADMIN, MANAGER, CASHIER | Matches |
| Sales History | `/sales-history` | TENANT_ADMIN, MANAGER, CASHIER | Matches |
| Products | `/products` | Nav: TENANT_ADMIN, MANAGER, STORE_KEEPER, CASHIER, RECEPTIONIST, ACCOUNTANT | **Mismatch** — route has no `ProtectedRoute roles` guard at all, so any authenticated role (including DOCTOR) can navigate to `/products` directly by URL even though it's hidden from their sidebar |
| Categories | `/categories` | TENANT_ADMIN, MANAGER, STORE_KEEPER, CASHIER, RECEPTIONIST, ACCOUNTANT | Matches |
| Purchases | `/purchases` | TENANT_ADMIN, MANAGER, STORE_KEEPER | Matches |
| Procurement | `/procurement` | TENANT_ADMIN, MANAGER, STORE_KEEPER | Matches |
| Warehouses | `/warehouses` | TENANT_ADMIN, MANAGER, STORE_KEEPER | Matches |
| Stock Transfers | `/stock-transfers` | TENANT_ADMIN, MANAGER, STORE_KEEPER | Matches |
| Accounting | `/accounting` | TENANT_ADMIN, MANAGER, ACCOUNTANT | Matches |
| Customers | `/customers` | any authenticated | **Mismatch risk** — no restriction anywhere; every role including DOCTOR/CASHIER can see full customer list/ledger |
| Suppliers | `/suppliers` | any authenticated | Same as above |
| Branches | `/branches` | any authenticated (in-page `canManage` limited to TENANT_ADMIN for edit actions only) | View access is unrestricted; only mutation is gated client-side |
| Optical Orders | `/optical-orders` | TENANT_ADMIN, MANAGER, RECEPTIONIST | Matches |
| Patients | `/patients` | TENANT_ADMIN, MANAGER, DOCTOR, RECEPTIONIST | Matches |
| Appointments | `/appointments` | TENANT_ADMIN, MANAGER, DOCTOR, RECEPTIONIST | Matches |
| Doctors | `/doctors` | TENANT_ADMIN, MANAGER, DOCTOR, RECEPTIONIST | Matches |
| Communication | `/communication` | TENANT_ADMIN, MANAGER, RECEPTIONIST, ACCOUNTANT | Matches |
| Automation Rules | `/automation-rules` | TENANT_ADMIN, MANAGER, RECEPTIONIST, ACCOUNTANT | Matches |
| AI Assistant | `/ai-assistant` | TENANT_ADMIN, MANAGER | Matches |
| Recommendations | `/recommendations` | TENANT_ADMIN, MANAGER | Matches |
| Expenses | `/expenses` | TENANT_ADMIN, MANAGER, ACCOUNTANT | Matches |
| Reports | `/reports` | TENANT_ADMIN, MANAGER, ACCOUNTANT | Matches |
| Users | `/users` | TENANT_ADMIN | Matches |

Full role set observed across the app: `TENANT_ADMIN, MANAGER, CASHIER, STORE_KEEPER, RECEPTIONIST, ACCOUNTANT, DOCTOR`. Note `DOCTOR` and `RECEPTIONIST` are clinic-vocabulary role names hard-coded into what is otherwise a generic RBAC list (`frontend/src/pages/users/Users.jsx:6`).

**Notable gap:** `/products`, `/customers`, `/suppliers`, `/branches` render for *any* authenticated user regardless of role — sidebar visibility is the only practical restriction for those four pages, not actual route-level RBAC. This is a candidate finding for the future RBAC/config work, not something this phase should fix.

---

## 3. Dashboard KPI Map

### `pages/dashboard/Dashboard.jsx` (simple/legacy dashboard, `GET /dashboard`)

| Widget | Metric | Source field |
|---|---|---|
| Stat card | Today's Sales (total + invoice count) | `data.todaySales.{total,count}` |
| Stat card | This Month's Sales | `data.monthSales.{total,count}` |
| Stat card | This Month's Purchases | `data.monthPurchases.total` |
| Stat card | Est. Gross Profit (Month) | `data.grossProfitEstimate` |
| Stat card | Inventory Value | `data.inventoryValue` |
| Stat card | Customers (count) | `data.customerCount` |
| Stat card | Suppliers (count) | `data.supplierCount` |
| Stat card | Pending Optical Orders | `data.pendingOpticalOrders` |
| List | Low Stock Items | `data.lowStockItems` / `data.lowStockCount` |
| List | Expiring Medicines (30 days) | `data.expiringMedicines` / `data.expiringCount` |

All computation happens server-side in the `dashboard` backend module; the frontend only renders. Every metric here is retail/optical-flavored except the sales/purchases/customer/supplier counts.

### `pages/dashboard/CommandCenter.jsx` (advanced dashboard, `GET /dashboard/command-center`, filterable by range/branch/category/product/supplier/customer/staff/payment status/order status)

**Always-visible KPI row** (`data.kpis.*`, not part of the hide/reorder widget system):
Sales, Gross Profit, Net Profit, Purchases, Expenses, Cash, Bank, Receivables, Payables, Inventory Value.

**Configurable widgets** (`DEFAULT_WIDGETS`, user can hide/reorder/save via `PUT /dashboard/preferences`):

| Widget id | Label | Data | Classification |
|---|---|---|---|
| `trends` | Sales & Profit Trend | `data.trends.sales[]`, `data.trends.profit[]` (custom SVG bar chart, no charting library) | Universal |
| `topProducts` | Top-Selling Products | `data.topProducts[]` (qty, revenue) | Universal |
| `mostProfitable` | Most Profitable Products | `data.mostProfitableProducts[]` (profit) | Universal |
| `stock` | Stock Alerts: Low / Slow-Moving / Dead / **Expiring Medicines (30 days)** | `data.stock.{lowStock,slowMoving,deadStock,expiringMedicines}` | Mixed — 3 of 4 boxes Universal, "Expiring Medicines" is pharmacy-specific and hard-coded, links to `/products?type=MEDICINE` |
| `opticalJobs` | Optical Jobs (Pending/Ready/Delayed) | `data.opticalJobs.{pending,ready,delayed}` | **Industry-specific**, hard-coded widget with no way to disable/rename per tenant industry beyond the generic show/hide toggle |
| `customers` | New vs Returning Customers | `data.customers.{new,returning}` | Universal |
| `outstanding` | Top Receivables / Top Payables | `data.outstandingPayments.{topReceivables,topPayables}` | Universal |
| `branchPerformance` | Branch Performance | `data.branchPerformance[]` | Universal |
| `staffPerformance` | Staff Performance | `data.staffPerformance[]` | Universal |

**AI Summary card** (`AiSummaryCard`): reads `data.ai` (pre-computed, not a live call) — shows top risks/opportunities/anomaly alerts, severity-badged, links to `/ai-assistant` and `/recommendations`. Feature-flaggable per `data.ai.isEnabled`.

All KPI math is computed backend-side; the frontend is a pure renderer plus a per-user widget-layout preference store. The widget *framework* (id/label/visible/order, saved per user/tenant) is a reusable Universal pattern — only the specific widget content (`opticalJobs`, "Expiring Medicines") is industry-locked into the switch statement (`CommandCenter.jsx:436-656`), not driven by an industry-pack config.

`CommandCenter.test.jsx` confirms the expected response shape (`kpis`, `trends`, `topProducts`, `mostProfitableProducts`, `stock`, `opticalJobs`, `customers`, `outstandingPayments`, `branchPerformance`, `staffPerformance`) matches what's rendered — no discrepancy between test fixtures and component behavior.

---

## 4. Hard-coded Branding/Labels Found

### Company name / brand strings

| Finding | File:line |
|---|---|
| `"AK VisionFlow"` sidebar brand name | `frontend/src/components/Layout.jsx:121` |
| `"Optical & Eyecare ERP"` sidebar tagline | `frontend/src/components/Layout.jsx:122` |
| `"AK"` brand mark (initials shown in sidebar logo box, no image asset) | `frontend/src/components/Layout.jsx:119` |
| `"AK VisionFlow"` login heading | `frontend/src/pages/auth/Login.jsx:32` |
| `"Create your AK VisionFlow account"` register heading | `frontend/src/pages/auth/RegisterTenant.jsx:35` |
| `akvf_token`, `akvf_user`, `akvf_theme`, `akvf_portal_token`, `akvf_portal_customer`, `akvf_portal_tenant`, `akvf_offline_<tenantId>` — brand-prefixed localStorage/IndexedDB key names | `frontend/src/api/client.js:8,17,18`; `frontend/src/context/AuthContext.jsx:8,11,15,16,24,25,32,33`; `frontend/src/context/ThemeContext.jsx:6,10`; `frontend/src/portal/PortalAuthContext.jsx:8,11,12,15,25,26,33,34`; `frontend/src/portal/portalApi.js:13,22,23`; `frontend/src/offline/db.js:13` |

No logo image file is referenced anywhere in `frontend/src` (no `<img>` pointing at a logo); branding is 100% text/CSS, which is actually a relatively easy lift for a future Tenant Branding Engine (swap two strings + the "AK" mark), but the strings are literal JSX text today, not pulled from tenant config/theme.

### Hard-coded color hex values outside the theme file

`frontend/src/index.css` is the sanctioned theme location and defines CSS custom properties (`--akvf-primary: #7c3aed`, `--akvf-accent: #0ea5e9`, etc. at lines 11-18, with a dark-mode override block at 33-39). However:

| Finding | File:line |
|---|---|
| `index.css` itself has additional literal hex values NOT expressed as tokens (status-pill colors, badges) | `frontend/src/index.css:108,155,191,194,198,203,206,210,230,421` |
| `Dashboard.jsx` `VARIANT_COLORS` map duplicates the brand purple/green/blue/etc. as literal hex/`rgba()` instead of referencing the CSS custom properties | `frontend/src/pages/dashboard/Dashboard.jsx:18-24` (e.g. `'#7c3aed'`, `'#16a34a'`, `'#0ea5e9'`, `'#64748b'`, `'#d97706'`, `'#dc2626'`) |
| `CommandCenter.jsx` re-hard-codes the same brand purple/green in the trend chart and optical-jobs icon | `frontend/src/pages/dashboard/CommandCenter.jsx:444` (`color="#7c3aed"`), `:452` (`color="#16a34a"`), `:535` (`background: 'rgba(124,58,237,.12)', color: '#7c3aed'`) |
| Products.jsx barcode print template hard-codes greys for print styling | `frontend/src/pages/products/Products.jsx:180,183` (`#ccc`, `#666`) |

Net effect: a Tenant Branding Engine that only swaps the CSS variables in `index.css` would **not** actually retheme the dashboards, since the two most prominent chart/KPI screens bypass the token system with their own literal color constants.

### Optical/clinic-specific UI labels hard-coded directly in JSX (not config-driven)

| Label / concept | File:line | Notes |
|---|---|---|
| `"FRAME"` / `"LENS"` product type options | `frontend/src/pages/products/Products.jsx:313-314,446-447` | Product "Type" enum is hard-coded to optical retail categories |
| `"Frame Brand"`, `"Frame Color"`, `"Lens Type"`, `"Lens Material"` form fields | `frontend/src/pages/products/Products.jsx:515,519,528,532` | Product edit form always shows optical-specific attribute fields |
| `"Optical Orders"` page heading / `"New Optical Order"` modal title / `"Frame Description"` / `"Lens Description"` / `"Prescription"` section header | `frontend/src/pages/opticalOrders/OpticalOrders.jsx:197,275,304,308,313` | Entire page is an optical-lab job tracker |
| `"Examination History"` / `"+ New Examination"` / `"Save Examination"` / `"Prescription History"` / `"+ New Prescription"` / `"Save Prescription"` / OD / OS / PD / "Diagnosis / notes" fields | `frontend/src/pages/patients/Patients.jsx:232-233,238-242,244,252,307-308,313-316,338` | Deepest industry lock-in in the codebase — clinical eye-exam vocabulary (OD/OS = right/left eye, PD = pupillary distance) hard-coded as literal field labels, not sourced from any clinical/industry config |
| `"Expiring Medicines (30 days)"` | `frontend/src/pages/dashboard/Dashboard.jsx:146`, `frontend/src/pages/dashboard/CommandCenter.jsx:504`, `frontend/src/pages/reports/Reports.jsx:105` (`"Medicine Expiry"` tab) | Pharmacy-vertical concept mixed into optical-vertical product data (`type: 'MEDICINE'`), suggesting the "Optical ERP" already silently absorbed a pharmacy use case ad hoc rather than through a formal industry-pack mechanism |
| `"Optical Jobs"` widget id/label, `"Pending/Ready/Delayed"` | `frontend/src/pages/dashboard/CommandCenter.jsx:34,528-530` | — |
| `"DOCTOR"` / `"RECEPTIONIST"` role names in a generic Users admin screen | `frontend/src/pages/users/Users.jsx:6` | Clinic staff roles hard-coded alongside retail roles (`CASHIER`, `STORE_KEEPER`) in one flat enum |
| `"Doctors"` page/nav label, `"Specialty"`/`"Designation"` fields | `frontend/src/pages/clinical/Doctors.jsx` (whole file), `frontend/src/components/Layout.jsx:68` | Whole page is a clinic-only "provider directory" with no generic "staff resource" abstraction |
| Portal tabs `['Overview', 'Optical Orders', 'Invoices', 'Appointments', 'Prescriptions']` | `frontend/src/pages/portal/PortalDashboard.jsx:9` | Customer-facing portal navigation is entirely optical-vocabulary and not derived from any tenant/industry config |
| `"Sign in to your clinic/shop account"` / `"Set up your shop/clinic in a few seconds"` | `frontend/src/pages/auth/Login.jsx:33`, `frontend/src/pages/auth/RegisterTenant.jsx:36` | Copy already hedges between two verticals ("clinic/shop") rather than being industry-neutral or config-driven — early evidence the product already senses it needs to generalize |

---

## Summary of Classification Counts

- **Universal** (would work unchanged for a non-optical business): Login, RegisterTenant, Dashboard (partly), POS, SalesHistory, Purchases, Customers, Suppliers, Branches, Expenses, Users, Accounting, Procurement, Warehouses, StockTransfers, Communication, AutomationRules, AiAssistant, RecommendationCenter, PortalLogin (mechanism) — ~19-20 screens
- **Module-specific** (generic pattern, optical-flavored defaults): Categories, Reports (shell), Appointments — 3 screens
- **Industry-specific** (hard-coded optical/eye-clinic domain concepts): OpticalOrders, Patients, Doctors, PortalDashboard, and the `opticalJobs`/"Expiring Medicines" widgets inside Dashboard/CommandCenter/Reports — 4 full screens + several embedded widgets
- **Configuration**: none of the audited screens are themselves tenant-configuration UI (no "Industry Pack" or "Branding" settings screen exists yet in `frontend/src/pages`)

This confirms the repositioning thesis: the bulk of the app (POS, accounting, procurement, CRM, HR/users, communications, AI) is already industry-agnostic in practice, but four screens plus several dashboard widgets, one enum (`DOCTOR`/`RECEPTIONIST` roles), and one product-type set (`FRAME`/`LENS`/`MEDICINE`) hard-code the optical/eye-clinic vertical directly into JSX and would need to move behind an Industry Pack + Tenant Branding Engine for the Business OS repositioning to hold.
