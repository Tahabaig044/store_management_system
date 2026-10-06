# AK VisionFlow — Project Audit Report

Full-project review covering the two issues flagged directly, plus other
gaps found while checking every page against what its backend module
already supports. Findings are ranked by how much they block daily use.

## 1. User-reported issues

### 1.1 No "Edit" button anywhere (confirmed, affects almost every module)

Checked every page under `frontend/src/pages/`: **none of them expose an
edit action.** Every list-page modal is wired for create only
(`POST /...`), even though the backend already has a working `PATCH /:id`
for most of these models:

| Page | Backend supports update? | Frontend edit UI? |
|---|---|---|
| Products | Yes (`PATCH /products/:id`) | No |
| Customers | Yes (`PATCH /customers/:id`) | No |
| Suppliers | Yes (`PATCH /suppliers/:id`) | No |
| Users | Yes (role/isActive only) | Partial — only the Activate/Deactivate toggle added this session |
| Optical Orders | Yes (`PATCH /optical-orders/:id`) | Only status can change (dropdown); frame/lens description, prescription, and amounts can't be corrected after creation |
| Expense Categories | Yes | No — the "+" modal only creates, there's no list/edit/delete |
| Purchases, Sales, Expenses | Intentionally not editable after creation (financial audit trail — see README's "never edited after the fact" rule) | N/A by design |

**Root cause:** this isn't a backend gap — it's that the Create modal on
each page was never extended to also open pre-filled for an existing row.

**Recommendation:** on Products, Customers, and Suppliers (the three
pages where editing is clearly safe and already have an `isActive`
toggle from this session), add an "Edit" button per row that opens the
same modal used for "+ New X", pre-filled with that row's data, and
calls `PATCH` instead of `POST` on submit. This is a small, mechanical
change since the modal/form JSX barely needs to change — only the
submit handler and an `editing` state variable. I can implement this
next if you want.

### 1.2 Barcode support is a text field only, not a real "barcode option"

`Products.jsx` has a plain text input labeled "Barcode," and POS search
matches against it — but there is no actual barcode workflow:

- **No scanner input handling.** A USB/Bluetooth barcode scanner types
  into whatever field has focus and sends Enter — POS's search box
  would technically work by accident today, but there's no explicit
  "scan to add" flow (auto-focus on page load, auto-add-to-cart on a
  barcode match, clear-and-refocus after).
- **No barcode generation.** There's no way to auto-generate a barcode
  for a new product (e.g. a simple incrementing/EAN-safe code) or print
  a barcode label — every barcode must be manually typed in, which
  defeats the point for products that don't already have a
  manufacturer barcode (most frames/lenses in an optical shop won't).

**Recommendation:**
1. Add a small client-side barcode-generation library (e.g. `jsbarcode`,
   already MIT-licensed and dependency-light) to render/print a barcode
   from the product's SKU or a generated code.
2. In POS, treat the search box as a scan target explicitly: keep it
   focused, and on Enter with an exact barcode match, add the item and
   clear the box automatically instead of requiring a manual click.
3. If actual camera-based scanning (not just a USB scanner) is wanted,
   that needs a real decision on scope/cost — it means a camera
   permission flow and a JS decoder (e.g. `@zxing/browser`); flagging
   this separately since it's a bigger addition than 1–2.

## 2. Other functional gaps found

### 2.1 "Pay" is implemented in the backend but never exposed

`POST /api/purchases/:id/pay` and `POST /api/optical-orders/:id/pay`
exist and work, but neither `Purchases.jsx` nor `OpticalOrders.jsx` has
a button that calls them. Right now there is **no way, from the UI, to
record a partial or follow-up payment** against a purchase or an
optical order once it's created — only the initial `amountPaid` at
creation time. For a shop that takes deposits (common for optical
orders — pay half now, rest on pickup), this is a significant gap, not
a cosmetic one.

### 2.2 No Categories or Branches management page

Both have full backend CRUD (`categories.routes.js`, `branches.routes.js`)
and a nav-less existence in the frontend — Products' category dropdown
reads from `GET /categories`, but nothing lets a tenant admin **create**
a new category or branch from the UI. Right now this only works because
the seed script pre-populates a couple of categories. A real shop adding
a new product type (e.g. "Contact Lenses") has no way to add that
category without direct database access.

### 2.3 No customer/supplier history/ledger view

`GET /customers/:id/history` and `GET /suppliers/:id/ledger` both exist
and return exactly what you'd want (past sales, orders, payments,
balance due) — but no row in `Customers.jsx` or `Suppliers.jsx` is
clickable to anything. This is useful, already-built backend
functionality with zero frontend to reach it.

### 2.4 Expense categories are create-only

The "Manage Categories" modal on the Expenses page only has an add
field — no list of existing categories, no way to rename or deactivate
one.

## 3. Security / data notes (lower priority, not urgent)

- **JWT is stored in `localStorage`** (`AuthContext.jsx`, `api/client.js`),
  not an httpOnly cookie — standard for SPA+API-on-different-origin
  setups (which is what we just deployed to Vercel), but it does mean a
  successful XSS anywhere in the app could exfiltrate the token. Not
  flagging as urgent since there's no known XSS vector in the app today,
  just noting it as a defense-in-depth item if this ever handles more
  sensitive data.
- **Role check inconsistency:** `customers.routes.js` lets any
  `CONTACTS_STAFF` role (Cashier, Store Keeper, Receptionist,
  Accountant, Manager, Tenant Admin) create/edit/archive a customer, but
  the equivalent supplier routes restrict create/edit/archive to
  `INVENTORY_STAFF` only. May be intentional (suppliers are more of an
  inventory-side concern), but worth a deliberate decision either way
  rather than leaving it as an inconsistency.

## 4. Test coverage

- Backend: one test file (`tests/api.test.js`) covering routing/auth/RBAC
  without a live database — per the README this is by design, but it
  means none of the business logic (atomic stock deduction, idempotent
  offline sync, sale reversal correctness) has automated test coverage
  today, only manual QA.
- Frontend: good coverage of shared components (`Modal`, `Pagination`,
  `StatusBadge`, `ProtectedRoute`) and the offline sync engine, but zero
  tests at the page level (no test exercises the Products/Customers/POS
  create-or-edit flow end to end).

## 5. Prioritized recommendations

1. **Add Edit to Products, Customers, Suppliers** (1.1) — most
   user-visible gap, low implementation effort, reuses existing modals.
2. **Expose the existing "Pay" endpoints** on Purchases and Optical
   Orders (2.1) — real money-handling gap, backend work is already done.
3. **Real barcode workflow** (1.2) — scan-to-add in POS first (small),
   generation/printing second (small-medium), camera scanning only if
   actually needed (medium-large).
4. **Categories & Branches management pages** (2.2) — currently a hard
   blocker for onboarding a second branch or a new product category.
5. **Customer/Supplier history view** (2.3) — wire up already-built
   backend endpoints, mostly frontend-only work.
6. Everything in section 3 (security notes) and section 4 (test
   coverage) — worth doing, not blocking day-to-day use.

None of this needs backend schema changes except possibly barcode
generation (which can stay entirely client-side, encoding the existing
`sku`/`barcode` field). Everything above is either already-built backend
functionality waiting for a frontend, or a well-scoped frontend addition.
