# Phase 0.1 — API & Business Logic Endpoint Inventory (Core Modules)

Evidence-based audit. No code changes were made. Scope: `backend/src/modules/{auth,users,branches,warehouses,categories,customers,suppliers,products,inventory,sales,purchases,payments,expenses,expenseCategories,dashboard,reports,settings}` plus `backend/src/middleware/*.js`, `app.js`, `config/env.js`, `utils/crudFactory.js`, `utils/jwt.js`.

All file:line references are to the state of the repo on `main` at the time of this audit (HEAD `26a0f3b`). All paths are relative to `backend/src/`.

## Method notes

- **Tenant scope enforcement** = the handler filters/verifies the target row by `tenantId` (directly, or via a parent record already verified against `tenantId`), not merely that `authenticate` produced a valid `req.user`.
- **Branch scope enforcement** = the handler applies `middleware/branchScope.js` (`branchScopeWhere` on reads, `assertBranchAccess` on writes) so a branch-restricted role (anyone except `TENANT_ADMIN`/`MANAGER`, per `branchScope.js:11`) cannot see/act on another branch's data once they have a branch assignment.
- **Test coverage** was located by grepping `backend/tests/*.test.js` for each route's path prefix (supertest-style `request(app).get('/api/...')` calls); see `backend/tests/` — there is no separate `tests/` folder under `backend/src`. Coverage is reported per module at the file level; a module being "covered" does not mean every sub-route/branch is asserted.

### Core platform files reviewed

| File | Role |
|---|---|
| `middleware/auth.js` | `authenticate` (JWT verify + re-fetch user/tenant, rejects portal/mobile-typed tokens), `requireTenant`, `requireRole(...roles)` |
| `middleware/branchScope.js` | `getAccessibleBranchIds`, `branchScopeWhere`, `assertBranchAccess` — Phase 6 branch isolation; `TENANT_ADMIN`/`MANAGER` are always unrestricted |
| `middleware/audit.js` | Fire-and-forget `logAudit()`, tenant/user resolved from `req.user` (falls back to `req.portal`) |
| `middleware/errorHandler.js` | Central error formatter; never leaks stack/DB internals |
| `utils/crudFactory.js` | `buildCrudController({model, createSchema, updateSchema, ...})` — generic tenant-scoped list/getOne/create/update/archive for simple master data |
| `utils/jwt.js` | `signToken`/`verifyToken` (HS256 pinned), plus `typ`-tagged portal/mobile token signers so those tokens can never hit staff routes |
| `app.js` | Mounts all routers under `/api/*`, global + auth-specific rate limiters, `trust proxy`, Helmet/CORS, 404 + error handler |
| `config/env.js` | Fails closed if `JWT_SECRET` is still the `.env.example` placeholder in production |

---

## auth (`modules/auth/`)

Router: `auth.routes.js`. No router-level middleware — each route sets its own.

| Method | Route | Handler | Auth MW | Role | Tenant Scope | Branch Scope | Validation | R/M | Tests |
|---|---|---|---|---|---|---|---|---|---|
| POST | `/api/auth/register-tenant` | `auth.controller.js:16` | none (public) + `authLimiter` (`app.js:121-129`) | none | N/A — creates the tenant | N/A | zod (`registerTenantSchema`) | Mutation | widely used as test setup helper across most `tests/*.test.js` |
| POST | `/api/auth/login` | `auth.controller.js:64` | none (public) + `authLimiter` | none | looks up user by email only, then checks `user.tenantId`'s tenant is active | N/A | zod (`loginSchema`) | Mutation (updates `lastLoginAt`, writes audit log) | used as test setup helper everywhere |
| GET | `/api/auth/me` | `auth.controller.js:89` | `authenticate` | none | `prisma.user.findUnique({id: req.user.id})` — self only, tenant is implicit in own record | N/A | none | Read | not directly exercised by name in `tests/`; indirectly relied upon by frontend only |

Notes: `login` deliberately does **not** filter by tenant when looking up the email (`auth.controller.js:69`) — correct, since email must be globally unique for login to be tenant-agnostic at that step; the tenant-active check happens after the user is found.

---

## users (`modules/users/`)

Router-level: `authenticate, requireTenant, requireRole(...TENANT_ADMIN_ONLY)` (`users.routes.js:40`) — every route here is Tenant-Admin-only.

| Method | Route | Handler | Auth MW | Role | Tenant Scope | Branch Scope | Validation | R/M | Tests |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/users/` | `users.routes.js:42` | authenticate+requireTenant | TENANT_ADMIN | `where: {tenantId}` | none (not needed — full user list is an admin function) | none | Read | `business.test.js`, `multiBranch.test.js`, `phase12Hardening.test.js` |
| POST | `/api/users/` | `users.routes.js:50` | authenticate+requireTenant | TENANT_ADMIN | creates with `tenantId: req.user.tenantId`; `assertBranchBelongsToTenant` (`users.routes.js:10`) checks any supplied `branchId` | branch existence checked, not branch-*access*-restricted (correct — only Tenant Admin can reach this route) | zod (`createSchema`, `ROLE_VALUES` enum) | Mutation | `phase12Hardening.test.js` (`USER_CREATE` audit test), `business.test.js` |
| PATCH | `/api/users/:id` | `users.routes.js:64` | authenticate+requireTenant | TENANT_ADMIN | `findFirst({id, tenantId})` before update (`users.routes.js:68`) | same `assertBranchBelongsToTenant` check | zod (`updateSchema`) | Mutation | `phase12Hardening.test.js` (`USER_UPDATE` audit test, password never logged) |

Note: self-deactivation guard at `users.routes.js:72-74` (cannot set your own `isActive: false`). No `DELETE`/archive route exists for users (inconsistent with every other master-data module, which all expose an archive endpoint).

---

## branches (`modules/branches/`)

Router-level: `authenticate, requireTenant` (`branches.routes.js:21`); per-route role checks. Uses `crudFactory` for the 5 CRUD routes.

| Method | Route | Handler | Auth MW | Role | Tenant Scope | Branch Scope | Validation | R/M | Tests |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/branches/` | crudFactory `list` via `branches.routes.js:23` | authenticate+requireTenant | ALL_ROLES | `where: {tenantId}` (`crudFactory.js:38`) | none — intentional, branch list itself is not restricted | none (query only) | Read | `multiBranch.test.js`, `business.test.js` |
| GET | `/api/branches/:id` | crudFactory `getOne` (`branches.routes.js:24`) | authenticate+requireTenant | ALL_ROLES | `findFirst({id, tenantId})` (`crudFactory.js:57-59`) | none | none | Read | `multiBranch.test.js` |
| POST | `/api/branches/` | crudFactory `create` (`branches.routes.js:25`) | authenticate+requireTenant | TENANT_ADMIN_ONLY | `data.tenantId = req.user.tenantId` (`crudFactory.js:73-75`) | N/A | zod (`createSchema`) | Mutation | `multiBranch.test.js` |
| PATCH | `/api/branches/:id` | crudFactory `update` (`branches.routes.js:26`) | authenticate+requireTenant | TENANT_ADMIN_ONLY | `findFirst({id, tenantId})` guard before update (`crudFactory.js:84-87`) | N/A | zod (`updateSchema`) | Mutation | `multiBranch.test.js` |
| DELETE | `/api/branches/:id` | crudFactory `archive` (`branches.routes.js:27`) | authenticate+requireTenant | TENANT_ADMIN_ONLY | `findFirst({id, tenantId})` guard (`crudFactory.js:99-102`) | N/A | none | Mutation | `multiBranch.test.js` |
| GET | `/api/branches/:id/access` | `branches.routes.js:31` | authenticate+requireTenant | TENANT_ADMIN_ONLY | branch looked up by `{id, tenantId}` first (`branches.routes.js:32`) | N/A | none | Read | `phase12Hardening.test.js` (indirectly, `BRANCH_ACCESS_GRANT`/`REVOKE` tests) |
| POST | `/api/branches/:id/access` | `branches.routes.js:38` | authenticate+requireTenant | TENANT_ADMIN_ONLY | branch **and** user both re-verified against `tenantId` (`branches.routes.js:43,45`) before the `UserBranchAccess` upsert | N/A | zod (`{userId}`) | Mutation | `phase12Hardening.test.js:208` |
| DELETE | `/api/branches/:id/access/:userId` | `branches.routes.js:57` | authenticate+requireTenant | TENANT_ADMIN_ONLY | branch re-verified against `tenantId` (`branches.routes.js:58`); `deleteMany` scoped to that branch id | N/A | none | Mutation | `phase12Hardening.test.js:208` |

---

## warehouses (`modules/warehouses/` — `warehouses.routes.js`, `stockTransfers.routes.js`, `warehouseStock.js`)

Router-level (both route files): `authenticate, requireTenant, requireRole(...INVENTORY_STAFF)`. `INVENTORY_STAFF = [TENANT_ADMIN, MANAGER, STORE_KEEPER]` (`constants/roles.js:18`) — `STORE_KEEPER` **is** branch-restricted once assigned a branch, per `branchScope.js`'s `UNRESTRICTED_ROLES`.

### warehouses.routes.js

| Method | Route | Handler | Tenant Scope | Branch Scope | Validation | R/M | Tests |
|---|---|---|---|---|---|---|---|
| GET | `/api/warehouses/` | `warehouses.routes.js:17` | `where: {tenantId}` | **none** — see Finding W-1 | none (query flag only) | Read | `multiBranch.test.js` |
| POST | `/api/warehouses/` | `warehouses.routes.js:33` (MANAGEMENT only) | creates with `tenantId`; branch checked against `tenantId` (`:38`) | N/A (MANAGEMENT is unrestricted) | zod (`createSchema`) | Mutation | `multiBranch.test.js` |
| PATCH | `/api/warehouses/:id` | `warehouses.routes.js:53` (MANAGEMENT only) | `findFirst({id, tenantId})` (`:57`) | N/A | zod (`updateSchema`) | Mutation | `multiBranch.test.js` |
| GET | `/api/warehouses/:id/stock` | `warehouses.routes.js:66` | `findFirst({id, tenantId})` (`:67`) | **none** — see Finding W-1 | none | Read | `multiBranch.test.js` |
| POST | `/api/warehouses/:id/receive` | `warehouses.routes.js:98` | warehouse + product both re-verified against `tenantId` (`:102,104`) | **none** — see Finding W-1 | zod (`stockMoveSchema`) | Mutation | `multiBranch.test.js` |
| POST | `/api/warehouses/:id/dispatch` | `warehouses.routes.js:133` | same as above | **none** — see Finding W-1 | zod (`stockMoveSchema`) | Mutation | `multiBranch.test.js` |
| POST | `/api/warehouses/:id/adjust` | `warehouses.routes.js:173` | same as above; role-based value-threshold check (`:187`) | **none** — see Finding W-1 | zod (`adjustSchema`) | Mutation | `multiBranch.test.js` |
| GET | `/api/warehouses/:id/history` | `warehouses.routes.js:218` | `findFirst({id, tenantId})` (`:219`) | **none** — see Finding W-1 | none | Read | `multiBranch.test.js` |

### stockTransfers.routes.js

| Method | Route | Handler | Tenant Scope | Branch Scope | Validation | R/M | Tests |
|---|---|---|---|---|---|---|---|
| GET | `/api/stock-transfers/` | `stockTransfers.routes.js:41` | `where: {tenantId}` | **none** — see Finding W-1 | none (query only) | Read | `multiBranch.test.js` |
| GET | `/api/stock-transfers/:id` | `stockTransfers.routes.js:62` | `findFirst({id, tenantId})` | **none** | none | Read | `multiBranch.test.js` |
| POST | `/api/stock-transfers/` | `stockTransfers.routes.js:71` | source/destination warehouses + every line's product re-verified against `tenantId` (`:87-97`) | **none** — no check that the requester may act for the *source* warehouse's branch | zod (`createSchema`) | Mutation | `multiBranch.test.js` |
| POST | `/api/stock-transfers/:id/approve` | `stockTransfers.routes.js:128` (MANAGEMENT only) | `findFirst({id, tenantId})` | N/A (MANAGEMENT unrestricted) | none | Mutation | `multiBranch.test.js` |
| POST | `/api/stock-transfers/:id/reject` | `stockTransfers.routes.js:141` (MANAGEMENT only) | `findFirst({id, tenantId})` | N/A | zod (`{reason}`) | Mutation | `multiBranch.test.js` |
| POST | `/api/stock-transfers/:id/cancel` | `stockTransfers.routes.js:158` | `findFirst({id, tenantId})` | **none** | none | Mutation | `multiBranch.test.js` |
| POST | `/api/stock-transfers/:id/dispatch` | `stockTransfers.routes.js:172` | `findFirst({id, tenantId})` | **none** — see Finding W-1 | none | Mutation | `multiBranch.test.js` |
| POST | `/api/stock-transfers/:id/receive` | `stockTransfers.routes.js:225` | `findFirst({id, tenantId})` | **none** — see Finding W-1 | zod (`receiveSchema`) | Mutation | `multiBranch.test.js` |

`warehouseStock.js` exports `ensureDefaultWarehouse`, `ensureWarehouseStock`, `adjustWarehouseStock` — internal helpers, not routes. See Finding W-2.

---

## categories (`modules/categories/`)

Router-level: `authenticate, requireTenant`. Uses `crudFactory` for `getOne`/`create`/`update`/`archive`; `list` is hand-written to attach product counts.

| Method | Route | Handler | Role | Tenant Scope | Branch Scope | Validation | R/M | Tests |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/categories/` | `categories.routes.js:20` (custom, not crudFactory) | CONTACTS_STAFF | `where: {tenantId}` (`:25`) | N/A (no branch dimension) | none | Read | `business.test.js`, `phase12Hardening.test.js` |
| GET | `/api/categories/:id` | crudFactory `getOne` (`:44`) | CONTACTS_STAFF | `findFirst({id, tenantId})` | N/A | none | Read | `business.test.js` |
| POST | `/api/categories/` | crudFactory `create` (`:45`) | INVENTORY_STAFF | `tenantId` injected | N/A | zod (`createSchema`) | Mutation | `phase12Hardening.test.js:83` |
| PATCH | `/api/categories/:id` | crudFactory `update` (`:46`) | INVENTORY_STAFF | `findFirst` guard | N/A | zod (`updateSchema`) | Mutation | `business.test.js` |
| DELETE | `/api/categories/:id` | crudFactory `archive` (`:47`) | INVENTORY_STAFF | `findFirst` guard | N/A | none | Mutation | `business.test.js` |

---

## customers (`modules/customers/`)

Router-level: `authenticate, requireTenant, requireRole(...CONTACTS_STAFF)`. CRUD via `crudFactory` (`supportsIdempotencyKey: true`); `:id/history` is hand-written.

| Method | Route | Handler | Tenant Scope | Branch Scope | Validation | R/M | Tests |
|---|---|---|---|---|---|---|---|
| GET | `/api/customers/` | crudFactory `list` | `where: {tenantId}` | N/A | none | Read | `business.test.js`, `api.test.js`, `accounting.test.js`, `mobileDashboard.test.js` |
| GET | `/api/customers/:id` | crudFactory `getOne` | `findFirst({id, tenantId})` | N/A | none | Read | `business.test.js` |
| POST | `/api/customers/` | crudFactory `create` | `tenantId` injected; idempotency-key dedup scoped to `{tenantId, idempotencyKey}` | N/A | zod (`createSchema`) | Mutation | `business.test.js` — this route is one of the fixed-IDOR-adjacent paths from commit `deaa562` |
| PATCH | `/api/customers/:id` | crudFactory `update` | `findFirst` guard | N/A | zod (`updateSchema`) | Mutation | `business.test.js`, `phase12Hardening.test.js:40` |
| DELETE | `/api/customers/:id` | crudFactory `archive` | `findFirst` guard | N/A | none | Mutation | `business.test.js` |
| GET | `/api/customers/:id/history` | `customers.routes.js:36` | customer verified `{id, tenantId}` (`:37-40`); sales/opticalOrders/payments queries all re-add `tenantId` (`:44,49,53`) even though `customerId` alone would already be tenant-implied | N/A | none | Read | `business.test.js` (reversed-sale balance fix, commit `deaa562`) |

---

## suppliers (`modules/suppliers/`)

Router-level: `authenticate, requireTenant, requireRole(...CONTACTS_STAFF)`; mutations additionally require `INVENTORY_STAFF`.

| Method | Route | Handler | Tenant Scope | Branch Scope | Validation | R/M | Tests |
|---|---|---|---|---|---|---|---|
| GET | `/api/suppliers/` | crudFactory `list` | `where: {tenantId}` | N/A | none | Read | `business.test.js`, `procurement.test.js` |
| GET | `/api/suppliers/:id` | crudFactory `getOne` | `findFirst({id, tenantId})` | N/A | none | Read | `business.test.js` |
| POST | `/api/suppliers/` | crudFactory `create`, INVENTORY_STAFF | `tenantId` injected | N/A | zod | Mutation | `phase12Hardening.test.js:66` |
| PATCH | `/api/suppliers/:id` | crudFactory `update`, INVENTORY_STAFF | `findFirst` guard | N/A | zod | Mutation | `business.test.js` |
| DELETE | `/api/suppliers/:id` | crudFactory `archive`, INVENTORY_STAFF | `findFirst` guard | N/A | none | Mutation | `phase12Hardening.test.js:66` (`SUPPLIER_ARCHIVE`) |
| GET | `/api/suppliers/:id/ledger` | `suppliers.routes.js:36` | supplier verified `{id, tenantId}`; purchases/payments queries re-add `tenantId` | N/A | none | Read | `business.test.js` |

---

## products (`modules/products/`)

Router-level: `authenticate, requireTenant`; reads gated `CONTACTS_STAFF`, writes gated `INVENTORY_STAFF`. Fully hand-written (not on `crudFactory` — legitimate: barcode-uniqueness check, opening-stock ledger entry, category FK check).

| Method | Route | Handler | Tenant Scope | Branch Scope | Validation | R/M | Tests |
|---|---|---|---|---|---|---|---|
| GET | `/api/products/` | `products.routes.js:55` | `where: {tenantId}` | N/A (products are tenant-wide, not per-branch) | none (query only) | Read | `business.test.js`, `api.test.js`, `mobileDashboard.test.js`, `multiBranch.test.js`, `procurement.test.js` |
| GET | `/api/products/:id` | `products.routes.js:86` | `findFirst({id, tenantId})` | N/A | none | Read | `business.test.js` |
| POST | `/api/products/` | `products.routes.js:95` | `tenantId` injected; barcode-uniqueness check is tenant-scoped (`assertBarcodeUnique`, `:12-18`); `categoryId` re-verified against `tenantId` (`:101`) | N/A | zod (`createSchema`, `PRODUCT_TYPES` enum) | Mutation | `business.test.js` (barcode tests), commit `deaa562` fixed the categoryId cross-tenant gap here |
| PATCH | `/api/products/:id` | `products.routes.js:128` | `findFirst` guard; barcode + category re-checked | N/A | zod (`updateSchema`) | Mutation | `business.test.js` |
| DELETE | `/api/products/:id` | `products.routes.js:147` | `findFirst` guard | N/A | none | Mutation | `business.test.js` |
| POST | `/api/products/:id/adjust-stock` | `products.routes.js:162` | `findFirst({id, tenantId})` inside the transaction (`:168`) | N/A | zod (`adjustSchema`) | Mutation | `business.test.js` |

**Industry-specific fields baked directly into this "Universal Core" entity:** `type` enum `['GENERAL','MEDICINE','FRAME','LENS']` and `frameBrand/frameModel/frameColor/frameSize/lensType/lensMaterial/lensCoating/batchNumber/expiryDate` (`products.routes.js:20,34-42`) — see Duplicated Logic / Refactor Candidates.

---

## inventory (`modules/inventory/`)

Router-level: `authenticate, requireTenant, requireRole(...INVENTORY_STAFF)`.

| Method | Route | Handler | Tenant Scope | Branch Scope | Validation | R/M | Tests |
|---|---|---|---|---|---|---|---|
| GET | `/api/inventory/transactions` | `inventory.routes.js:10` | `where: {tenantId}` (`:15`) | **none** — no `branchScopeWhere` even though `InventoryTransaction.warehouseId` implies a branch; a STORE_KEEPER sees every branch's stock-movement history tenant-wide | none (query filters only) | Read | `business.test.js` |

---

## sales (`modules/sales/`)

Router-level: `authenticate, requireTenant, requireRole(...SALES_STAFF)`. Fully hand-written (accounting postings, stock deduction, idempotency, threshold-gated discount approval).

| Method | Route | Handler | Tenant Scope | Branch Scope | Validation | R/M | Tests |
|---|---|---|---|---|---|---|---|
| GET | `/api/sales/` | `sales.routes.js:45` | `where: {tenantId, ...branchScopeWhere}` (`:50`) | **applied** — `branchScopeWhere(prisma, req.user)` | none (query only) | Read | `business.test.js`, `api.test.js`, `accounting.test.js`, `multiBranch.test.js` |
| GET | `/api/sales/:id` | `sales.routes.js:72` | `findFirst({id, tenantId, ...branchScopeWhere})` (`:74`) | **applied** | none | Read | `business.test.js` |
| POST | `/api/sales/` | `sales.routes.js:81` | customer/branch/each line's product all re-verified against `tenantId` inside the transaction (`:99,103,136-139`) | **applied** — `assertBranchAccess(prisma, req.user, branchId)` (`:106`) | zod (`createSchema`, `itemSchema`) | Mutation | `business.test.js` (idempotency, negative-stock, discount-threshold, accounting-posting tests) |
| POST | `/api/sales/:id/reverse` | `sales.routes.js:275` (MANAGEMENT only) | `findFirst({id, tenantId})` (`:277`) | N/A (MANAGEMENT unrestricted); note: item-level `tx.product.findUnique({id})` at `:285` has no explicit `tenantId` re-check, but `line.productId` only ever comes from this tenant-verified sale's own `items` relation, created tenant-checked at sale time — see Finding S-1 | none | Mutation | `business.test.js` (reversed-sale balance-due fix, commit `deaa562`) |

---

## purchases (`modules/purchases/`)

Router-level: `authenticate, requireTenant, requireRole(...INVENTORY_STAFF)`. Fully hand-written (accounting postings for immediate/deferred receipt + advances, idempotency).

| Method | Route | Handler | Tenant Scope | Branch Scope | Validation | R/M | Tests |
|---|---|---|---|---|---|---|---|
| GET | `/api/purchases/` | `purchases.routes.js:163` | `where: {tenantId, ...branchScopeWhere}` | **applied** | none | Read | `business.test.js`, `api.test.js`, `accounting.test.js` |
| GET | `/api/purchases/:id` | `purchases.routes.js:186` | `findFirst({id, tenantId, ...branchScopeWhere})` | **applied** | none | Read | `business.test.js` |
| POST | `/api/purchases/` | `purchases.routes.js:195` | supplier + every line's product + branch all re-verified against `tenantId` (`:218-227`) | **applied** — `assertBranchAccess` (`:212`) | zod (`createSchema`, `itemSchema`) | Mutation | `business.test.js` — this route is a named fix target of commit `deaa562` ("previously a tenant could reference another tenant's supplier/product by ID... combined with `receiveImmediately` this could inflate another tenant's real stock") |
| POST | `/api/purchases/:id/receive` | `purchases.routes.js:301` | `findFirst({id, tenantId})`; `receivePurchaseStock` (`:137`) re-verifies every item's product against `purchase.tenantId` as defense-in-depth | **none** — no `assertBranchAccess` on this action itself (relies on the branch check already done at create time) | none | Mutation | `business.test.js` |
| POST | `/api/purchases/:id/pay` | `purchases.routes.js:329` | `findFirst({id, tenantId})` | **none** | zod (`{amount, method, note}`) | Mutation | `business.test.js` |
| POST | `/api/purchases/:id/return` | `purchases.routes.js:402` (MANAGEMENT only) | `findFirst({id, tenantId})` | N/A (MANAGEMENT unrestricted); same `tx.product.findUnique({id})`-without-tenantId pattern as sales reversal — see Finding S-1 | none | Mutation | `business.test.js` |

---

## payments (`modules/payments/`)

Router-level: `authenticate, requireTenant, requireRole(...FINANCE_STAFF)`. Read-only by design — payments are created as a side effect of sales/purchases/expenses, never directly.

| Method | Route | Handler | Tenant Scope | Branch Scope | Validation | R/M | Tests |
|---|---|---|---|---|---|---|---|
| GET | `/api/payments/` | `payments.routes.js:12` | `where: {tenantId}` (`:17`) | **none** — no `branchScopeWhere`, even though `Sale`/`Purchase`/`Expense` all carry `branchId`; a branch-restricted ACCOUNTANT sees every branch's payments | none (query filters only) | Read | **no test file references `/api/payments`** |

---

## expenses (`modules/expenses/`)

Router-level: `authenticate, requireTenant, requireRole(...FINANCE_STAFF)`. Fully hand-written (accounting posting, threshold-gated approval).

| Method | Route | Handler | Tenant Scope | Branch Scope | Validation | R/M | Tests |
|---|---|---|---|---|---|---|---|
| GET | `/api/expenses/` | `expenses.routes.js:33` | `where: {tenantId, ...branchScopeWhere}` | **applied** | none | Read | `business.test.js`, `api.test.js`, `multiBranch.test.js`, `phase12Hardening.test.js` |
| POST | `/api/expenses/` | `expenses.routes.js:54` | category + branch re-verified against `tenantId` (`:67,70`) | **applied** — `assertBranchAccess` (`:73`) | zod (`createSchema`) | Mutation | `phase12Hardening.test.js:110`, `business.test.js` — categoryId ownership check added in commit `deaa562` |
| PATCH | `/api/expenses/:id` | `expenses.routes.js:125` | `findFirst({id, tenantId})`; new `categoryId` re-verified (`:132`) | **none** — no `assertBranchAccess` re-check on update, and `updateSchema` does not allow changing `branchId` anyway, so low impact | zod (`updateSchema`) | Mutation | `phase12Hardening.test.js:110` (`EXPENSE_UPDATE`) |

---

## expenseCategories (`modules/expenseCategories/`)

Router-level: `authenticate, requireTenant, requireRole(...FINANCE_STAFF)`. Pure `crudFactory`.

| Method | Route | Handler | Tenant Scope | Branch Scope | Validation | R/M | Tests |
|---|---|---|---|---|---|---|---|
| GET | `/api/expense-categories/` | crudFactory `list` | `where: {tenantId}` | N/A | none | Read | `business.test.js`, `multiBranch.test.js`, `phase12Hardening.test.js` |
| GET | `/api/expense-categories/:id` | crudFactory `getOne` | `findFirst` | N/A | none | Read | `business.test.js` |
| POST | `/api/expense-categories/` | crudFactory `create` | `tenantId` injected | N/A | zod | Mutation | `phase12Hardening.test.js:99` |
| PATCH | `/api/expense-categories/:id` | crudFactory `update` | `findFirst` guard | N/A | zod | Mutation | `business.test.js` |
| DELETE | `/api/expense-categories/:id` | crudFactory `archive` | `findFirst` guard | N/A | none | Mutation | `business.test.js` |

---

## dashboard (`modules/dashboard/`)

Router-level: `authenticate, requireTenant` only — **no router-level role gate**.

| Method | Route | Handler | Role | Tenant Scope | Branch Scope | Validation | R/M | Tests |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/dashboard/` | `dashboard.routes.js:21` | **none beyond requireTenant** — see Finding D-1 | every query filtered `{tenantId}` | none | none | Read | `business.test.js`, `api.test.js`, `accounting.test.js`, `ai.test.js`, `clinical.test.js`, `communication.test.js`, `multiBranch.test.js` |
| GET | `/api/dashboard/command-center` | `dashboard.routes.js:153` | MANAGEMENT | tenant-filtered throughout; explicit ownership re-checks for every optional filter id (`branchId/categoryId/productId/supplierId/customerId/staffId`) against `tenantId` before use (`:162-173`) — a deliberate, well-documented IDOR-prevention pattern | filter-level only (`f.branchId` passed through to `where`, not enforced as the *caller's own* branch — but route is MANAGEMENT-only, who are branch-unrestricted anyway, so this is consistent) | zod (`filterSchema`) | Read | `business.test.js`, `accounting.test.js`, `multiBranch.test.js` |
| GET | `/api/dashboard/preferences` | `dashboard.routes.js:679` | MANAGEMENT | keyed `{tenantId, key: prefix+userId}` | N/A | none | Read | not directly referenced by name in `tests/` |
| PUT | `/api/dashboard/preferences` | `dashboard.routes.js:686` | MANAGEMENT | same | N/A | zod (`preferencesSchema`) | Mutation | not directly referenced by name in `tests/` |

---

## reports (`modules/reports/`)

Router-level: `authenticate, requireTenant, requireRole(...FINANCE_STAFF)`. All read-only, all hand-written (aggregation reports).

| Method | Route | Handler | Tenant Scope | Branch Scope | Validation | R/M | Tests |
|---|---|---|---|---|---|---|---|
| GET | `/api/reports/sales/daily` | `reports.routes.js:16` | `where: {tenantId}` | **none** | none | Read | `api.test.js` |
| GET | `/api/reports/sales/monthly` | `reports.routes.js:39` | `where: {tenantId}` | **none** | none | Read | `api.test.js` |
| GET | `/api/reports/inventory` | `reports.routes.js:58` | `where: {tenantId}` | N/A (products are tenant-wide) | none | Read | `api.test.js` |
| GET | `/api/reports/stock-movement` | `reports.routes.js:81` | `where: {tenantId}` | **none** | none | Read | `api.test.js` |
| GET | `/api/reports/expenses` | `reports.routes.js:97` | `where: {tenantId}` | **none** | none | Read | `api.test.js` |
| GET | `/api/reports/profit-loss` | `reports.routes.js:114` | `where: {tenantId}` (via `sale.tenantId`/`expense.tenantId`) | **none** | none | Read | `api.test.js` |
| GET | `/api/reports/optical-orders` | `reports.routes.js:139` | `where: {tenantId}` | **none** | none | Read | `api.test.js` |
| GET | `/api/reports/medicine-expiry` | `reports.routes.js:152` | `where: {tenantId}` | N/A | none | Read | `api.test.js` |

None of the eight report endpoints apply `branchScopeWhere`, so a branch-restricted `ACCOUNTANT` (in `FINANCE_STAFF`, not in `UNRESTRICTED_ROLES`) sees tenant-wide sales/expenses/stock-movement figures across every branch. This is the same class of gap as payments/inventory-transactions above (see Finding B-1).

`GET /medicine-expiry` (`reports.routes.js:152`) hard-codes `type: 'MEDICINE'` — an Optical/Pharmacy-specific report living in the otherwise-generic Reports module.

---

## settings (`modules/settings/`)

Router-level: `authenticate, requireTenant`.

| Method | Route | Handler | Role | Tenant Scope | Branch Scope | Validation | R/M | Tests |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/settings/` | `settings.routes.js:11` | ALL_ROLES | `where: {tenantId}` | N/A | none | Read | `communication.test.js`, `multiBranch.test.js`, `procurement.test.js` |
| PUT | `/api/settings/:key` | `settings.routes.js:16` | TENANT_ADMIN_ONLY | keyed `{tenantId, key}` via `upsert` — `key` itself is not tenant data, so no lookup-by-id IDOR is possible here | N/A | zod (`{value: string}`) | Mutation | `communication.test.js`, `multiBranch.test.js` |

---

# Security Findings

Severity definitions per the audit brief: **Critical** = tenant isolation/data integrity broken; **High** = likely major rework or a hard-coded single-tenant/single-branch assumption; **Medium/Low** = narrower access-control or defense-in-depth gaps.

No Critical (tenant-isolation-breaking) findings were found in the 17 in-scope modules. Every `:id`-addressed read/mutation route reviewed filters or verifies its target row against `req.user.tenantId` (directly, via `findFirst({id, tenantId})`, or via a parent record already tenant-verified). This is consistent with commit `deaa562` ("Fix cross-tenant IDOR on foreign-key payloads..."), which specifically targeted this class of bug across customers/products/purchases/sales/users/expenses, and which `tests/business.test.js` now exercises directly (62-test integration suite doing live reproduction of the fixed IDOR paths). This audit's own route-by-route review corroborates that those fixes hold.

### High

**W-1. Branch-isolation is entirely absent from the Warehouses and Stock Transfers modules, letting a branch-restricted STORE_KEEPER see and mutate stock at branches they have no assignment to.**
- Evidence: `modules/warehouses/warehouses.routes.js` never imports or calls `branchScopeWhere`/`assertBranchAccess` from `middleware/branchScope.js` — not on `GET /` (`:17-24`, no branch filter on the tenant-wide warehouse list), not on `GET /:id/stock` (`:66-91`), not on `POST /:id/receive` (`:98-131`), `POST /:id/dispatch` (`:133-166`), `POST /:id/adjust` (`:173-215`), or `GET /:id/history` (`:218-229`). Same absence in `modules/warehouses/stockTransfers.routes.js` (`GET /` at `:41-60`, `POST /` at `:71-126`, `POST /:id/dispatch` at `:172-210`, `POST /:id/receive` at `:225-294`). `Warehouse.branchId` exists specifically for this purpose (`prisma/schema.prisma:1106`).
- Contrast: `sales.routes.js`, `purchases.routes.js`, and `expenses.routes.js` all call `branchScopeWhere`/`assertBranchAccess` for exactly this reason, and `middleware/branchScope.js`'s own header comment states the intended model explicitly ("Manager... Tenant Admin/Owner may access all branches... any other role IS restricted... once they actually have a branch assigned"). Warehouses/Stock Transfers is the one Phase-6-era module that never adopted it.
- Exploit scenario: A `STORE_KEEPER` whose `User.branchId` is Branch A (no `UserBranchAccess` grant to Branch B) calls `GET /api/warehouses` to enumerate Branch B's warehouse id, then `POST /api/warehouses/<branchBWarehouseId>/adjust` (or `/receive`, `/dispatch`) to silently move or write off Branch B's stock — a segregation-of-duties break that the rest of the codebase's Phase 6 branch model was explicitly built to prevent. The same STORE_KEEPER can also request/dispatch/receive a `StockTransfer` between two warehouses neither of which is their own branch.
- Also affects: `modules/inventory/inventory.routes.js:10` (`GET /transactions` has no `branchScopeWhere` despite `InventoryTransaction.warehouseId` implying a branch) and `modules/payments/payments.routes.js:12` (`GET /` has no `branchScopeWhere` despite `Payment` rows deriving from branch-scoped sales/purchases/expenses) — same missing-branch-filter pattern, grouped here as one systemic gap rather than three separate findings.

### Medium

**D-1. The base dashboard (`GET /api/dashboard/`) exposes tenant-wide financial figures to every authenticated role, with no `requireRole` gate at all.**
- Evidence: `dashboard.routes.js:10` sets router-level middleware to `authenticate, requireTenant` only; the `/` handler at `:21` has no additional `requireRole(...)` (contrast with `/command-center` at `:153`, which is explicitly `requireRole(...MANAGEMENT)`).
- Impact: Any tenant role — including `CASHIER`, `STORE_KEEPER`, `RECEPTIONIST`, `DOCTOR` — can call this endpoint and receive `monthSales.total`, `grossProfitEstimate`, `inventoryValue`, `monthPurchases.total`, and full customer/supplier counts (`dashboard.routes.js:80-93`). This is a least-privilege gap rather than a tenant-isolation break, but it is inconsistent with how tightly `command-center` (containing similar/overlapping figures) is gated one route below it in the same file.

**B-1. Eight `reports/` endpoints, plus `payments/` and `inventory/transactions`, have no branch scoping.**
- Evidence: none of `reports.routes.js`'s eight routes (`:16,39,58,81,97,114,139,152`) call `branchScopeWhere`; same for `payments.routes.js:17` and `inventory.routes.js:15`.
- Impact: a branch-restricted `ACCOUNTANT`/`STORE_KEEPER` (both are in the relevant `FINANCE_STAFF`/`INVENTORY_STAFF` role groups and both are branch-restricted once assigned) sees tenant-wide payments, tenant-wide stock-movement history, and every P&L/sales/expense report across all branches, not just their own. Rolled into this finding rather than W-1 because reports/payments/inventory-transactions are read-only (no mutation risk), unlike the warehouse actions in W-1.

### Low / defense-in-depth

**W-2. `warehouseStock.js`'s internal helpers do not filter by `tenantId` themselves.**
- Evidence: `ensureWarehouseStock` (`warehouseStock.js:34`) does `tx.warehouseStock.findMany({where: {productId}})` — no `tenantId` in the `where` clause, relying entirely on every caller having already verified `productId` belongs to the tenant. Currently safe because every call site (`warehouses.routes.js`, `stockTransfers.routes.js`) does perform that check first, but the helper itself provides no defense if a future caller forgets to.
- Recommendation: accept/require `tenantId` inside the `where` clause here too (`product: {tenantId}` join filter), matching the "verify at the point of DB access, not just at the route" pattern already used elsewhere (e.g. `receivePurchaseStock`'s own comment in `purchases.routes.js:140-142` about exactly this principle).

**S-1. Sale-reversal and purchase-return paths trust historical line-item `productId`s without re-verifying `tenantId` at the point of mutation.**
- Evidence: `sales.routes.js:285` and `purchases.routes.js:417` both do `tx.product.findUnique({where: {id: line.productId}})` with no `tenantId` filter, inside handlers whose parent `sale`/`purchase` *was* verified against `tenantId` a few lines earlier. Not currently exploitable (the `productId` values come only from that tenant-verified record's own `items` relation, which could only have been created against tenant-owned products per the P-side fix in commit `deaa562`), but it is inconsistent with `receivePurchaseStock`'s own explicit defense-in-depth re-check of the identical pattern.

---

# Duplicated Logic / Refactor Candidates

1. **Sequential document-number generation** (`nextInvoiceNumber` in `sales.routes.js:30`, `nextPurchaseNumber` in `purchases.routes.js:132`, `nextTransferNumber` in `stockTransfers.routes.js:18`) — three near-identical `count-then-padStart` implementations, not centralized into a shared `utils/` helper. All three also share the same race-condition characteristic (count-based numbering inside a transaction, not a DB sequence) — worth reviewing together if ever revisited.

2. **Threshold-gated "requires MANAGEMENT approval" control**, implemented independently four times with the same shape (fetch a `Setting` row → compare a computed value against it → `throw ConflictError` unless `MANAGEMENT.includes(req.user.role)`):
   - `largeDiscountThreshold` — `sales.routes.js:113-125`
   - `largeExpenseThreshold` — `expenses.routes.js:75-86`
   - `stockAdjustmentApprovalThreshold` — `warehouses.routes.js:182-189`
   - `transferApprovalThreshold` — `stockTransfers.routes.js:101-102` (via `getApprovalThreshold`, `:23-28`)
   A single `utils/approvalThreshold.js` (`assertUnderThreshold(tx, tenantId, settingKey, value, role)`) would remove ~40 duplicated lines and guarantee any future threshold feature follows the same audited pattern.

3. **Ad hoc foreign-key ownership checks** (`prisma.<model>.findFirst({where: {id, tenantId}})`, then `if (!x) throw new NotFoundError(...)`) are hand-written at every call site rather than centralized — e.g. `products.routes.js:101` (category), `sales.routes.js:99,103` (customer, branch), `purchases.routes.js:218,221,225` (supplier, product×N, branch), `expenses.routes.js:67,70` (category, branch), `warehouses.routes.js:38` (branch), `branches.routes.js:43,45` (branch, user). This is the exact pattern commit `deaa562` had to retrofit across five files after finding it missing — a shared `assertOwned(tx, model, id, tenantId, label)` helper (returning the row or throwing `NotFoundError`) would make "did we forget this check on a new FK" structurally harder to get wrong, and is a natural companion to `crudFactory.js`'s existing `findFirst`-then-`NotFoundError` idiom.

4. **Pagination boilerplate** (`page`/`pageSize` parsing, `Math.min(pageSize, 100)`, `skip`/`take`) is repeated verbatim in `crudFactory.js:34-36`, `categories.routes.js:21-23`, `warehouses` (stockTransfers) `:42-44`, `products.routes.js:56-58`, `sales.routes.js:46-48`, `purchases.routes.js:164-166`, `expenses.routes.js:34-36`, `payments.routes.js:13-15`, `inventory.routes.js:11-13`. A shared `parsePagination(query, {maxPageSize})` util already has an obvious single call-site shape and would remove ~9 duplicated blocks.

5. **`crudFactory.js` reuse vs. bypass** — Universal-Core-shaped modules on `crudFactory`: **branches**, **categories** (custom `list`, factory `getOne`/`create`/`update`/`archive`), **customers**, **suppliers**, **expenseCategories**. Modules that bypass it entirely with hand-written controllers: **users** (justified: password hashing, self-deactivation guard, no archive route at all — this last part looks like an oversight rather than a deliberate design choice, since every other master-data module has one), **products** (justified: barcode uniqueness, opening-stock ledger, category FK, industry-specific fields), **warehouses/stockTransfers/inventory/sales/purchases/expenses** (all justified: real business-transaction logic — stock movement, accounting postings, threshold approvals — well beyond simple CRUD). No unjustified bypasses were found; `crudFactory` is being used exactly where it's the right fit.

6. **Hard-coded Optical/Medical industry assumptions inside modules that should be Universal Core:**
   - `products.routes.js:20,34-42` — the shared `Product` create/update schema bakes in `type: 'GENERAL'|'MEDICINE'|'FRAME'|'LENS'` plus nine optics/pharmacy-specific fields (`frameBrand/frameModel/frameColor/frameSize/lensType/lensMaterial/lensCoating`, `batchNumber`, `expiryDate`) directly onto the one universal product entity, rather than via a tenant-configurable custom-fields/attributes mechanism (a "Configuration" concern per the classification rubric).
   - `reports.routes.js:152` — `GET /medicine-expiry` hard-codes `type: 'MEDICINE'` inside the otherwise-generic Reports module.
   - `dashboard.routes.js:57,67` (base dashboard) and the entire `clinicalKpis`/`opticalJobs` block of `command-center` (`:432-512,589-593`) — optical/medical KPIs (`pendingOpticalOrders`, `expiringMedicines`, appointments/examinations/doctor-performance) are wired directly into the two universal dashboard endpoints rather than being contributed by an optional Clinical/Optical module. This is architecturally consistent with the stated current state ("Optical/Eye-Clinic/Medical-Store focused") but is exactly the coupling that would need to be broken for the "universal modular Business OS" repositioning — every tenant using only the Universal Core today still pays the query cost for, and sees empty/zero blocks from, clinical and optical KPIs on every dashboard load.

---

# Module Classification

| Module | Classification | Rationale |
|---|---|---|
| auth | Platform-Infrastructure | Login/registration/session identity — not a business entity |
| users | Universal Core | Staff/user management is foundational to every tenant regardless of industry |
| branches | Universal Core | Explicitly listed as Universal Core in the brief; multi-location is a horizontal concern |
| warehouses | Universal Core | Stock-location tracking underlies inventory for any goods-based business; current implementation has the branch-isolation gap noted in Finding W-1 |
| categories | Configuration | Product categorization is a customizable taxonomy, not itself a core transaction entity |
| customers | Universal Core | Explicitly listed as Universal Core |
| suppliers | Universal Core | Explicitly listed as Universal Core |
| products | Universal Core (with Industry Module fields leaking in) | Core entity, but its schema/endpoints hard-code Optical/Medical fields (see Duplicated Logic §6) that belong in an Industry Module's extension of the core entity |
| inventory | Universal Core | Stock-transaction ledger (`inventoryTransaction`) is foundational for any goods-based business |
| sales | Universal Core | Explicitly listed as Universal Core |
| purchases | Universal Core | Explicitly listed as Universal Core |
| payments | Universal Core | Explicitly listed as Universal Core |
| expenses | Universal Core | Explicitly listed as Universal Core |
| expenseCategories | Configuration | Same rationale as `categories` |
| dashboard | Universal Core (base `/`), but currently entangled with Industry Module data | The base dashboard's shape (sales/purchases/inventory/customers KPIs) is core reporting; `command-center`'s clinical/optical/communication blocks are Industry-Module-specific data reached through what should be a universal endpoint |
| reports | Universal Core | "Core reporting" is explicitly listed as Universal Core, though `medicine-expiry` is Industry-Module-specific content inside it |
| settings | Configuration | Free-form tenant key/value store — the definition of a Configuration concern |

---

# Summary of audit coverage

- **87 routes** enumerated and evidenced across the 17 in-scope modules (including the two route files and one helper file that live under `modules/warehouses/`).
- **0 Critical**, **1 High** (W-1, systemic branch-isolation gap in Warehouses/Stock Transfers), **2 Medium** (D-1 dashboard role gate; B-1 branch scoping missing in reports/payments/inventory-transactions), **2 Low/defense-in-depth** (W-2, S-1) findings.
- **6 duplicated-logic / refactor candidates** identified, plus a `crudFactory` reuse map and three concrete instances of Optical/Medical assumptions hard-coded into otherwise-universal modules.
