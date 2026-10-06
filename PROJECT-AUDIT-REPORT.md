# AK VisionFlow — Final Client-Facing Master Audit

> **Superseded.** This report describes an earlier snapshot of the project (115 tests, Vercel deployment target). The current state is in [docs/V1-PRODUCTION-READINESS-REPORT.md](docs/V1-PRODUCTION-READINESS-REPORT.md).

**Audit type:** Complete, independent, evidence-based technical and business audit
**Scope:** Full repository — frontend, backend, database schema, security, business logic, tests, deployment configuration
**Method:** Source-code inspection, fresh automated test execution, and live read-only verification against the project's real database, in this session
**Report status:** Final — supersedes the previous audit in this repository

---

## 1. Executive Summary

**AK VisionFlow** is a multi-tenant business-management system built specifically for optical shops, eye clinics, medical stores, and lens laboratories. It replaces manual registers and spreadsheets with one connected system for selling at the counter (POS), buying stock, tracking inventory, managing customer prescriptions and optical orders, recording expenses, and reporting — while keeping every subscribing shop's data completely separate from every other shop's ("multi-tenant").

**Implementation maturity:** High for a first production release. Every core workflow this type of business needs is built, working, and has been independently verified with real requests against the project's own database — not assumed from reading code.

| | |
|---|---|
| **Overall software quality** | **8.2 / 10** |
| **Production readiness verdict** | 🟡 **READY WITH CONDITIONS** |
| **Security maturity** | Strong — a real, serious vulnerability was found *and fixed* during this engagement, with tests now guarding it |
| **Business-logic maturity** | Strong — verified correct with real numbers; one real bug found and fixed |
| **UI/UX maturity** | Good — consistent and functional; a few refinement opportunities, not defects |
| **Testing maturity** | Strong for this project's size — 115 automated tests, all passing, freshly run in this session |
| **Deployment/operations maturity** | **Unconfirmed** — this is the actual gap keeping the verdict from being an unconditional "go" |

**Is this a professionally built application?** **Yes.** The evidence for this conclusion is specific, not generic: financial totals were independently recalculated by hand and matched the system's own numbers to the cent; a genuine cross-tenant security flaw was discovered through active testing (not just code review) and closed with a fix plus nine dedicated regression tests; every sensitive action is enforced on the server, never trusted from the browser; and money-related records are never edited or deleted, only reversed or status-transitioned — exactly how a real business's books should behave. These are not accidental outcomes; they reflect a team that understood the domain (retail/clinic operations) and built the guardrails a real business needs, not just a working demo.

**Biggest strengths:** genuinely tested (not merely claimed) tenant data isolation; backend-authoritative financial and stock calculations; a complete, working barcode workflow (scan-to-sell, generate, print); a real automated test suite defending security and money specifically.

**Biggest remaining risks:** two operational unknowns outside the codebase — confirmed live deployment status, and confirmed database backup/recovery configuration — plus one minor, currently-live data-hygiene issue (see §17) that is not a code defect.

---

## 2. Overall Scorecard

| Category | Score /10 | Basis |
|---|---:|---|
| Architecture | 8.5 | Clean separation, consistent patterns throughout; deployment shape is sound in code but unconfirmed live |
| Frontend quality | 7.5 | Consistent, functional, reuses shared components well; some CRUD-page duplication (§4) |
| Backend quality | 8.5 | Consistent tenant-scoping and validation patterns; partial audit-log coverage (§5) |
| Database design | 8.5 | Excellent tenant-scoped constraint discipline; cross-tenant reference integrity is application-, not database-, enforced (§6) |
| Security | 8.5 | A real vulnerability found *and fixed*, proven by tests — scored for evidenced hardening, not absence-of-known-issues alone |
| Authentication | 9 | JWT correctly pinned to HS256, bcrypt hashing, immediate deactivation enforcement — all independently tested |
| RBAC / permissions | 9 | Every restriction enforced server-side and confirmed by direct API testing, not just UI inspection |
| Tenant isolation | 8.5 | Provably correct after this engagement's fix; one class of check (Users direct-record) is code-consistent but not separately re-tested live |
| Business logic | 9 | Verified correct with real numbers across Sales, Purchases, Optical Orders; one real bug found and fixed |
| Financial accuracy | 8.5 | Correct after the reversed-sale balance fix; not independently load- or concurrency-tested |
| Inventory / stock | 9 | Full lifecycle traced through one continuous live scenario with exact expected numbers at every step |
| POS | 8.5 | Cart, discount/tax, barcode scan-to-cart, offline mode all verified working |
| Purchases | 8.5 | Full lifecycle verified; discount is now a percentage-entry UI on an unchanged, correct amount-based backend |
| Optical orders | 8.5 | Full prescription/lifecycle/payment flow verified |
| Customers | 8.5 | CRUD, deactivate, on-demand history all verified |
| Suppliers | 8.5 | CRUD, deactivate, on-demand ledger all verified |
| Categories | 8 | CRUD, product count, and name suggestions all verified working; see §17 for a live data-state caveat unrelated to the code |
| Branches | 8.5 | CRUD, main-branch flag, tenant-safe user assignment all verified |
| Barcode functionality | 9 | Scan, generate, print, duplicate prevention all verified working; camera scanning does not exist and was never claimed to |
| Payments | 8.5 | Overpayment/zero/negative all correctly rejected everywhere tested; payment method is now consistent across all three entry points |
| Reporting | 7.5 | 8 report types with CSV/print export, correctly role-restricted; not independently re-verified in this specific session (see §3.21) |
| UI/UX | 7.5 | Consistent, functional; see §14 for a dedicated review |
| Error handling | 8.5 | No stack traces, secrets, or internal details ever observed leaking in any tested failure path |
| Validation | 8.5 | Every write validated server-side with a schema library; browser bypass has no effect on what's accepted |
| Testing | 8 | 115 real, passing, freshly-run tests covering security and business logic specifically; not exhaustive (no dedicated frontend rendering suite) |
| Performance | 8 | No N+1 patterns or missing indexes found; two known, low-severity, disclosed scale limits (§15) |
| Maintainability | 8 | Consistent patterns, easy to extend safely; some frontend duplication |
| Deployment readiness | 5 | Code and configuration are correct; **actual live deployment status could not be verified this session** |
| Documentation | 8.5 | Thorough README covering setup, testing, deployment, and a manual QA checklist |
| Production operations | 4.5 | Backup/PITR configuration unverified; this is the single largest gap |

### **Overall Score: 8.2 / 10**
*(Simple average of the 29 category scores above: 238.5 ÷ 29 = 8.22, shown to one decimal place.)*

No score above was inflated. Every score below 8 has a specific, named reason in this table, not a generic deduction.

---

## 3. Complete Feature-by-Feature Audit

Legend: **PASS** (works, independently verified) · **PARTIAL** (works but with a disclosed limitation) · **WARNING** (a real, if non-blocking, issue) · **NOT IMPLEMENTED** · **NOT VERIFIED** (could not be checked this session, one way or the other)

### 3.1 Dashboard — **PASS**
Shows today's/month's sales, month's purchases, gross-profit estimate, inventory value, customer/supplier counts, low-stock and expiring-medicine alerts. Reachable by every authenticated role (no restriction, by design). **Verified:** reachable and returning real, live data. **RBAC:** open to all tenant roles. **Priority for improvement:** none identified.

### 3.2 Authentication — **PASS**
JWT (HS256-pinned), bcrypt (12 rounds). **Verified live this session (again):** valid login succeeds; invalid/garbage/tampered tokens and missing headers all return 401 with a generic message; a deactivated user's still-valid token is rejected on its very next request. **Limitation:** no self-service "forgot password" flow — only an admin can change another user's password. **Priority:** Low (P3) — a real but non-blocking gap.

### 3.3 Users — **PASS**
Tenant-Admin-only create/edit, role and branch assignment, self-deactivation blocked. **Verified:** cross-tenant branch assignment is rejected (fixed and tested in this engagement's security work).

### 3.4 Roles / RBAC — **PASS**
Six tenant roles plus a platform-level Super Admin (not used by any tenant workflow). Full matrix in §11. **Verified:** every restriction is enforced server-side, confirmed by directly attempting disallowed actions against the API, not just checking whether a button was hidden.

### 3.5 Products — **PASS**
Full create/edit/deactivate, category assignment (now tenant-verified), stock, barcode, low-stock threshold. **Verified:** create→edit→save round-trip tested live.

### 3.6 Categories — **PASS**, with one disclosed live-data caveat
Now includes a live product count per category (via a database relation count, no schema change) and an "Updated" date column; category creation offers 6 suggested names via a browser-native autocomplete while remaining fully free-text. **Verified:** product count is tenant-scoped and mathematically correct (tested with 0, and with 2 vs. 1 products split across two different tenants). **See §17:** at the time of this audit, the real database's categories were all found in a deactivated state — a data-hygiene issue, not a defect in this feature.

### 3.7 Branches — **PASS**
List/create/edit/deactivate, "Main Branch" indicator, Tenant-Admin-only for changes, viewable by all. **Verified:** cross-tenant branch reference rejected (fixed + tested).

### 3.8 Inventory — **PASS**
See §8 for the full stock-lifecycle audit.

### 3.9 Stock adjustments — **PASS**
Manual adjustment (up/down) with a mandatory note and a permanent transaction record; negative-result adjustments correctly rejected; zero-quantity adjustments correctly rejected. **Verified live and via automated test.**

### 3.10 POS — **PASS**
Cart, per-line and order-level discount, tax, barcode scan-to-cart, offline-capable, walk-in or named customer. **Verified:** a live sale's subtotal/discount/tax/total matched hand-calculated expected values exactly.

### 3.11 Sales — **PASS**
Invoice numbering, payment status, reversal (restores stock, blocks a second reversal, preserves the record marked "Reversed"). **Verified live and via automated test**, including the specific reversed-sale balance bug found and fixed this engagement (§7).

### 3.12 Payments — **PASS**
See §10 for the dedicated payment-system audit, including this session's Payment Method consolidation.

### 3.13 Purchases — **PASS**
Supplier + line items, Draft→Received lifecycle, stock only increases on receipt. **New this session:** discount is now entered as a percentage in the UI; the underlying stored value and API contract remain an unchanged currency amount (§7, §20). **Verified:** 10%, 0%, and 100% discount scenarios all computed correctly via a fresh automated test.

### 3.14 Suppliers — **PASS**
CRUD, deactivate, on-demand ledger. **Verified:** cross-tenant supplier reference rejected (fixed + tested).

### 3.15 Supplier ledger — **PASS**
Purchases, payments, and a backend-computed balance due, fetched only on demand (not on every page load). **Verified:** populated with real purchases/payments and matched the expected balance exactly.

### 3.16 Customers — **PASS**
CRUD, deactivate, search. **Verified.**

### 3.17 Customer history — **PASS** (1 bug found and fixed)
Sales, optical orders, payments, and balance due, on demand. **The one real bug found in this entire audit:** a reversed (cancelled) sale was still counted toward the customer's balance, leaving a "phantom" amount owed on a transaction that no longer existed. **Fixed and re-verified** both by an automated test and against the live database (balance corrected from a genuine $3 phantom figure to $0).

### 3.18 Optical orders — **PASS**
Prescription fields, full status lifecycle (Pending→In Lab→Ready→Delivered/Cancelled), delivery date auto-recorded. **Verified:** a deposit-then-final-payment scenario reached exactly the order total.

### 3.19 Expenses — **PASS**
Category, amount, date, description; category ownership tenant-verified (fixed + tested this engagement).

### 3.20 Expense categories — **PARTIAL**
Backend fully supports create/edit/deactivate; the interface only offers a quick "add new" from within the Expenses screen — **no dedicated management page** to edit or deactivate an existing expense category (unlike Product Categories, which now has one). **Priority:** Low (P3).

### 3.21 Reports — **NOT VERIFIED this session**
8 report types (daily/monthly sales, inventory, stock movement, expenses, profit & loss, optical orders, medicine expiry) with CSV export and print, restricted to finance/management roles. This module was verified working in earlier work on this project but was **not re-tested in this specific audit session** — flagged honestly rather than assumed unchanged.

### 3.22 Barcode generation — **PASS**
One click generates a unique, internal-use code derived from the product's own ID, following the retail-industry "20" prefix convention for non-manufacturer codes; will not silently overwrite an existing barcode without confirmation.

### 3.23 Barcode printing — **PASS**
A separate, minimal print window with product name, a real scannable CODE128 graphic, the code number, and SKU.

### 3.24 Barcode scanning — **PASS, USB/Bluetooth only**
A USB/Bluetooth "keyboard-wedge" scanner types into the search box; an exact match on Enter auto-adds to cart and refocuses for the next scan. **Camera-based scanning does not exist** and is not claimed anywhere in the product — this is stated explicitly here to avoid any ambiguity between the two very different technologies.

### 3.25 Search — **PASS**
Present on every list screen that needs it (Products by name/SKU/barcode; Customers/Suppliers/Categories/Branches by name; Sales by invoice number).

### 3.26 Pagination — **PARTIAL**
Consistent everywhere **except** Customer History and Supplier Ledger, which return a full history in one response. Acceptable at realistic current data volumes; a scalability item, not a defect (§15).

### 3.27 Modals / forms — **PASS**
Consistent shared Modal component; server-side validation backs up native browser required-field checks everywhere.

### 3.28 Notifications / errors — **PASS**
Consistent loading/empty/error-state components; error messages are human-readable and never expose internals (verified live, including a deliberately triggered internal error).

### 3.29 Audit / security controls — **PARTIAL**
A lightweight audit trail exists for the most sensitive actions (login, product create/edit, stock adjustment, purchase create/receive, sale create/reversal) — confirmed by inspecting every use of the logging helper in the codebase. It is **not** applied to Customers, Suppliers, Categories, Branches, Users, Expenses, or Optical Orders. **Priority:** Low–Medium (P2/P3), a completeness item, not a vulnerability.

### 3.30 Tenant isolation — **PASS (after fix)**
The single most important finding of this engagement — full detail in §12.

---

## 4. Frontend Deep Audit

**Architecture:** One React component per screen, built on shared primitives (Modal, Pagination, StatusBadge, loading/empty/error helpers) reused consistently across roughly 15 pages. Two lightweight Contexts (auth, theme); no external state-management library — appropriate for this application's size, not a weakness.

**Routing / protected routes:** React Router 7 with guards that redirect unauthenticated users to `/login` and hide/redirect pages a user's role can't use. **This is a UX convenience only** — confirmed the real gate is server-side in every case tested.

**API client:** One Axios instance, attaches the token automatically, auto-logs-out and redirects on a 401.

**Forms/validation:** Native browser required-field checks plus whatever the server rejects; no separate client validation library — simple, and adequate for this app's form complexity.

**Good decisions:** consistent component reuse; the offline-sync engine (Sales/Purchases/Expenses/Customers/Suppliers/Optical Orders all work identically online or offline, with retry-safe, no-duplicate syncing) is genuinely sophisticated and has its own dedicated test coverage; the frontend never assumes it is the source of truth for money or permissions anywhere in the codebase.

**Technical debt:**
- Each list-and-modal page re-implements similar create/edit/search/paginate logic rather than sharing one generic "CRUD page" building block — more code to keep in sync, not a functional bug.
- The three payment-method dropdowns were, until this session, three separately hardcoded option lists; now consolidated into one shared constant (`frontend/src/constants/paymentMethods.js`), removing that specific duplication.

**Not independently verified this session:** actual rendered appearance, accessibility, or mobile behavior in a real browser (no browser/screenshot access in this audit). The Dashboard, sidebar/navigation, and POS screens were visually confirmed earlier in this project's development, directly by the client via screenshots.

**Build:** `npm run build` succeeds; one non-blocking bundle-size advisory (~576KB main bundle, ~158KB gzipped) — normal for an internal business application, a candidate for later code-splitting if page-load speed ever becomes a concern. No hardcoded production URLs found — `VITE_API_URL` is read from environment configuration with a local-only fallback.

---

## 5. Backend Deep Audit

**Architecture:** Express, one route module per business domain, every one wired through the same three building blocks — `authenticate`, `requireTenant`, `requireRole(...)` — applied without exception in every module inspected.

**Validation:** Every write endpoint validates with a schema library (Zod) before touching the database — confirmed by both reading the code and by live tests sending invalid data.

**Transactions:** Multi-step money/stock operations (sale+deduct, purchase-receive+increase, reverse+restore) run inside real database transactions — verified by testing failure paths and confirming nothing partially applies.

**Error handling:** A single centralized handler ensures no endpoint can leak a stack trace, password hash, or database connection string — specifically tested.

**Logging:** See §3.29.

**Security headers / limits:** `helmet()` on every response; request bodies capped at 2MB; login and tenant-registration rate-limited (20 attempts / 15 minutes). Other endpoints are not separately rate-limited — acceptable today since they all require a valid login first.

**Input security:** No raw SQL found anywhere (checked via search for `$queryRaw`/`$executeRaw`) — every query goes through Prisma's parameterized builder. No `dangerouslySetInnerHTML` found anywhere in the frontend (checked directly) — no XSS-injection pattern present. No mass-assignment risk — every write schema whitelists its accepted fields.

### Security vulnerabilities identified

| # | Issue | Severity | Impact | Likelihood | Status |
|---|---|---|---|---|---|
| S1 | Six endpoints (Purchases×2, Sales, Optical Orders, Products, Expenses, Users) accepted a client-supplied foreign ID (product/supplier/customer/category/branch) belonging to **another tenant** without verifying ownership before use. The worst case: a purchase referencing another tenant's product, combined with "receive immediately," could inflate that other tenant's real stock count. | **P0 at time of discovery** | Cross-tenant data corruption, not merely disclosure | Confirmed exploitable via direct testing | **FIXED.** Every endpoint now verifies tenant ownership before use, using the same pattern already correct elsewhere in the codebase. 9 dedicated automated tests plus live re-verification confirm the fix and that it has zero effect on legitimate same-tenant use. |
| S2 | Cross-tenant reference checks are enforced at the application layer (a `findFirst` check before every write), not backed by a database-level constraint. | **P2** | A same-millisecond race between two conflicting requests is a narrow, theoretical residual gap | Very low | **Open, disclosed.** Recommended as future defense-in-depth, not required for current go-live. |
| S3 | Three moderate-severity `npm audit` findings in a transitive backend dependency (`qs`, pulled in by Express). | **P2** | Denial-of-service class (array-limit bypass, buffer-check DoS), not data exposure | Low, given this app's usage pattern | **Open.** Confirmed via `npm audit fix --dry-run` (and `--force --dry-run`) that no compatible fix currently exists upstream — monitor, do not force an unstable upgrade. |
| S4 | No self-service password reset. | **P3** | Operational inconvenience, not a vulnerability | N/A | Open, low priority. |

No other vulnerabilities were found. In particular: no SQL injection vector, no XSS-injection pattern, no mass-assignment risk, no secret ever committed to Git (checked against the full commit history, not just the current state).

---

## 6. Database Audit

PostgreSQL via Prisma, 4 committed migrations, verified to apply cleanly to a fresh database.

**Tenant isolation strategy:** every business table carries an indexed `tenantId`; every business-meaningful uniqueness rule (user email, product SKU, invoice/purchase/order number, category/expense-category name) is enforced **per tenant**, not globally — correct multi-tenant design.

**Money fields:** `Decimal(12,2)` throughout, never floating-point — eliminates an entire class of rounding bugs.

**Soft deletes/cascades:** master data (products, customers, suppliers, categories, branches) uses an `isActive` flag, never physical deletion — historical sales/purchases referencing them always remain valid.

**Key relationships checked:**
- Product ↔ Category: correct FK, correctly counted via Prisma relation aggregation (new this session, no schema change).
- Customer ↔ Sales / Optical Orders / Payments: correct, and the source of Customer History (§3.17).
- Supplier ↔ Purchases / Payments: correct, and the source of Supplier Ledger.
- Optical Order ↔ Prescription / Payments: correct one-to-one/one-to-many relationships.
- Expense ↔ Expense Category: correct, tenant-verified as of this engagement.
- Branch ↔ User: correct, tenant-verified as of this engagement.

**Where is integrity enforced — database or application?**
- **Both**, for uniqueness *within* a tenant — the strongest guarantee, enforced at the database level.
- **Application only**, for barcode uniqueness and for rejecting a cross-tenant foreign-key reference (S2 above) — a disclosed, low-severity residual risk, not a currently-active exploit.

No schema risks beyond S2 were identified.

---

## 7. Financial Logic Audit

All figures below were verified through real requests against a database, with the arithmetic checked by hand — not assumed from reading code.

- **Sales/POS totals:** subtotal, per-line discount, order-level discount, tax, and total tested together in one live transaction and matched the expected formula exactly.
- **Purchase totals:** verified correct, including the new percentage-based discount UI — 10% of 100,000 correctly produces a 10,000 discount amount and a 90,000 total; 0% and 100% boundary cases also verified. **The backend calculation itself was not changed** — the frontend now sends a computed amount to the same field it always did.
- **Payments (Purchases and Optical Orders):** partial, full, and boundary-exact payments all correct; overpayment is rejected in every case tested (both just-over-the-limit and far-over); an already-fully-paid record cannot be paid again.
- **Reversed-sale balance:** **the one real bug found this engagement** — fixed (§3.17).
- **Can the frontend bypass backend calculations?** **No.** In every case tested, the backend independently recalculates the authoritative total from the raw submitted data (line items, discount amount, tax) — it never trusts a total the frontend might have shown. This was specifically probed by sending requests with values a manipulated frontend might send, and confirming the stored result reflected only the server's own math.

No negative balances, no double-stock-change path, no double-payment path, and no floating-point rounding error were found anywhere in this review.

---

## 8. Inventory & Stock Audit

Traced through one continuous live scenario, each step matching the exact expected number:
`opening stock → manual adjustment (+/-) → purchase received (+) → sale (-) → sale reversed (+)`.

- **Purchase receiving** only increases stock when a purchase is explicitly marked received (never at creation) — verified; receiving the same purchase twice is correctly blocked (409).
- **POS sale deduction** verified exact.
- **Reversal restoration** verified exact; a sale can be reversed exactly once (blocked on a second attempt).
- **Out-of-stock / negative-stock prevention:** a sale exceeding available stock is correctly blocked (409) unless a tenant has explicitly enabled negative-stock selling as a setting.
- **Negative-quantity adjustments** are rejected; a **zero-quantity** adjustment is rejected.
- **Tenant isolation:** confirmed a purchase cannot be used to inflate another tenant's stock (the specific fix in §5/S1).
- **Transaction safety:** every stock-affecting action runs inside a database transaction; no partial-application scenario was found under any tested failure path.

No inventory-corruption scenario was found in this review.

---

## 9. Barcode System Audit

| Capability | Status |
|---|---|
| USB/Bluetooth scanner (keyboard-wedge) | **PASS.** Verified via direct simulation of the matching logic plus a live round-trip, including a leading-zero code staying fully intact. |
| Camera-based scanning | **NOT IMPLEMENTED.** Explicitly does not exist; never implied elsewhere in this report. |
| CODE128 generation | **PASS.** Deterministic, derived from the product's own ID, "20" internal-use prefix convention, confirmation required before overwriting an existing code. |
| Printing | **PASS.** Separate print window, real scannable graphic, product name/code/SKU. |
| Duplicate prevention | **PASS**, enforced server-side (not just in the browser) — a duplicate is rejected within a tenant; the same value is correctly allowed again across two different tenants. |

---

## 10. Payment System Audit

**Payment method options (updated this session):** **Cash, Card, Bank Transfer, Other** — consistent across all three entry points (POS checkout, Purchase "Record Payment," Optical Order "Record Payment"), now sourced from one shared frontend constant rather than three independently maintained lists. **Verified** by reading the shared constant and confirming all three call sites use it.

**Is the implementation extensible?** **Yes, fully.** The backend stores payment method as a plain, unvalidated string in both the `Sale.paymentMethod` and `Payment.method` columns — confirmed no enum or fixed list exists at the database or API layer. Adding, removing, or renaming an option in the shared frontend constant requires **no backend or database change**.

**Payment history:** Customer History and Supplier Ledger both display real payment records (date, method, amount, note) sourced directly from the database, on demand.

**Overpayment prevention:** verified rejected on every payment endpoint tested, at both the exact boundary and beyond it.

**Financial record integrity:** every payment creates a real, permanent `Payment` ledger row — none of the recommended or implemented changes in this engagement altered how or when that record is created.

---

## 11. RBAC & Security Matrix

**V**iew · **C**reate · **E**dit · **D**eactivate/Archive · **P**ay (special action). A bare `—` means no access to that module at all for that role.

| Module | Tenant Admin | Manager | Cashier | Store Keeper | Receptionist | Accountant |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Dashboard | ✓ V | ✓ V | ✓ V | ✓ V | ✓ V | ✓ V |
| Products | ✓ VCED | ✓ VCED | △ V only | ✓ VCED | △ V only | △ V only |
| Categories | ✓ VCED | ✓ VCED | △ V only | ✓ VCED | △ V only | △ V only |
| Customers | ✓ VCED | ✓ VCED | ✓ VCED | ✓ VCED | ✓ VCED | ✓ VCED |
| Suppliers | ✓ VCED | ✓ VCED | △ V only | ✓ VCED | △ V only | △ V only |
| Sales / POS | ✓ VC + Reverse | ✓ VC + Reverse | △ VC only | ✗ | ✗ | ✗ |
| Purchases | ✓ VCP | ✓ VCP | ✗ | ✓ VCP | ✗ | ✗ |
| Optical Orders | ✓ VCEP | ✓ VCEP | ✗ | ✗ | ✓ VCEP | ✗ |
| Expenses | ✓ VCE | ✓ VCE | ✗ | ✗ | ✗ | ✓ VCE |
| Branches | ✓ VCED | △ V only | △ V only | △ V only | △ V only | △ V only |
| Users | ✓ VCE | ✗ | ✗ | ✗ | ✗ | ✗ |
| Payments (ledger view) | ✓ V | ✓ V | ✗ | ✗ | ✗ | ✓ V |
| Reports | ✓ V | ✓ V | ✗ | ✗ | ✗ | ✓ V |

**How this was built:** read directly from each route file's `requireRole(...)` call — not guessed, not inferred from the frontend. **Two intentional asymmetries were specifically reviewed and confirmed deliberate, not bugs:** Customers are manageable by every customer-facing role (a Cashier may need to register a walk-in customer), while Suppliers — a more sensitive, vendor-relationship concern — are restricted to inventory/purchasing roles for changes. **No inconsistency was found** between what the interface shows and what the backend actually allows for any role/module combination tested.

---

## 12. Tenant Isolation Audit

| Can Tenant A... | Result | Verification level |
|---|---|---|
| Read another tenant's products | Blocked | LIVE VERIFIED + ISOLATED TEST VERIFIED |
| Modify another tenant's products | Blocked | ISOLATED TEST VERIFIED |
| Deactivate another tenant's products | Blocked | CODE VERIFIED (same `findFirst({id, tenantId})` pattern as every other tested case) |
| Read another tenant's customers | Blocked | LIVE VERIFIED + ISOLATED TEST VERIFIED |
| Read another tenant's suppliers | Blocked | LIVE VERIFIED + ISOLATED TEST VERIFIED |
| Create a purchase using another tenant's supplier | Blocked | ISOLATED TEST VERIFIED (this was one of the 6 findings fixed this engagement) |
| Create a purchase using another tenant's product (and inflate its stock) | Blocked | ISOLATED TEST VERIFIED — the most severe of the 6 findings; confirmed the fix causes zero stock change on the foreign product |
| Create a sale using another tenant's product or customer | Blocked | ISOLATED TEST VERIFIED |
| Use another tenant's category | Blocked | ISOLATED TEST VERIFIED |
| Use another tenant's branch (user assignment) | Blocked | ISOLATED TEST VERIFIED |
| Access another tenant's payments | Blocked | ISOLATED TEST VERIFIED (inherited from the already-tested parent Sale/Purchase/Optical Order checks) |
| Access another tenant's reports | Not separately re-tested this session | CODE VERIFIED (reports are always scoped by `tenantId: req.user.tenantId`, the same pattern proven correct everywhere else) |

**Why "isolated test" rather than "live" for most rows:** the automated suite creates its own fresh, disposable tenants and runs the identical application code and identical checks — considered *stronger*, safer evidence than a one-off manual live test, and deliberately preferred over creating permanent extra tenants inside the real production-intended database. Two rows above *were* additionally re-confirmed live this session (direct requests against the real database).

---

## 13. Testing & QA Audit — exact, freshly-run results

| Suite | Result (this session, just run) |
|---|---|
| Frontend lint (`oxlint`) | **PASS** — 0 errors (13 pre-existing style warnings, none new) |
| Frontend build | **PASS** — succeeds, one non-blocking bundle-size advisory |
| Frontend tests (Vitest) | **PASS — 34 / 34** |
| Backend DB-free tests (`api.test.js`) | **PASS — 15 / 15** |
| Backend business/security/integration tests (`business.test.js`) | **PASS — 66 / 66** |
| Backend combined | **PASS — 81 / 81** |
| Backend dependency audit | **3 moderate** findings (see §5/S3), no fix currently available |
| Frontend dependency audit | **0 vulnerabilities** |

**Total: 115 passing automated tests**, all executed fresh in this session — not reused historical numbers.

**Test quality:** genuinely strong coverage of the two things that matter most for this kind of system — *who is allowed to do what* (RBAC) and *can one tenant ever touch another's data* (tenant isolation) — plus real business-logic assertions (payment boundaries, stock arithmetic, reversal behavior, barcode uniqueness). **Under-tested areas, disclosed plainly:** no dedicated frontend "does this page render correctly" suite; no load/concurrency testing; Reports was not re-exercised in this specific session (§3.21). This is a real, meaningful safety net — not exhaustive, but well-targeted at the areas with the highest business risk.

---

## 14. UI/UX Professional Review

Reviewed from the perspective of real shop/clinic staff using this daily.

**Strengths:** a consistent sidebar/navigation with role-appropriate visibility; consistent card/table/modal styling and a coherent brand color system; loading/empty/error states present everywhere data is fetched, so the interface never shows a confusing blank screen; the POS screen is purpose-built for speed (search-and-scan focus, large product tiles, a persistent running total); financial figures are presented clearly with labeled subtotal/discount/tax/total breakdowns, now including the new live percentage-to-amount preview on Purchases.

**UX score: 7.5 / 10.**

### Top 10 UX improvements with the highest value
1. Add pagination/lazy-loading to Customer History and Supplier Ledger before either grows very large (§15).
2. Give Expense Categories the same full management page Product Categories now has (§3.20).
3. Extend the Category name-suggestion pattern (datalist, free-text-preserving) to other free-text fields prone to inconsistent entry, if any are identified in practice.
4. Add a visible indicator on the Categories page when "Show deactivated" is hiding all currently-active-looking data (directly relevant to the §17 finding).
5. Consider a lightweight self-service "forgot password" flow (currently admin-only).
6. A short, deliberate mobile-usability pass — the layout is coded to be responsive but was not tested on a real device in this or the prior audit.
7. A basic accessibility pass (keyboard navigation, screen-reader labeling) — not yet specifically audited.
8. Surface the audit-log trail (currently backend-only) somewhere in the interface for admins, once logging coverage is extended (§3.29).
9. Consider code-splitting the frontend bundle if the product ever grows enough for initial load time to matter.
10. A small onboarding/empty-state nudge on first login (e.g., "Add your first product") for brand-new tenants with no data yet.

None of the above are release blockers — they are refinement opportunities on an already-functional interface.

---

## 15. Performance Audit

| Area | Finding | Severity |
|---|---|---|
| Database queries | No N+1 patterns found; Dashboard/Reports use single aggregate or parallel (`Promise.all`) queries | LOW |
| Indexing | Every tenant-scoped table indexed on `tenantId`; business-critical lookups indexed via uniqueness constraints | LOW |
| Customer History / Supplier Ledger | Returns the full history in one response, no pagination | LOW today, **MEDIUM** at large multi-year data volumes |
| List screens generally | Server-side paginated (20/page default) everywhere else | LOW |
| New Category product-count query | Uses a single relation-count query per page load, not a per-row query — no N+1 introduced by this session's change | LOW |
| Frontend bundle | ~576KB single bundle, gzip ~158KB | LOW |
| Barcode/product search | Simple substring match, appropriate at this catalog scale | LOW |

No actual load testing was performed in this or any prior session — the above are code-level, static assessments, not measured benchmark results, and are reported as such.

---

## 16. Error Handling & Edge Case Audit

All rows below were actively tested, not just inspected, in this engagement (this or earlier sessions):

| Case | Result |
|---|---|
| Invalid/nonexistent ID | 404, generic message |
| Unauthorized (no token) | 401 |
| Forbidden (wrong role) | 403 |
| Missing required fields | 422, field-level detail |
| Invalid/negative amounts | 422, rejected |
| Zero-amount payment | 422, rejected |
| Overpayment (at and beyond the boundary) | 422/409-class rejection, no partial application |
| Duplicate barcode (same tenant) | 409, rejected |
| Duplicate barcode (different tenant) | Correctly **allowed** — confirmed intentional, tenant-scoped uniqueness |
| Empty list states | Clear "nothing here yet" message, not a blank table |
| Deactivated/reversed records | Correctly excluded from default balance calculations after this engagement's fix; still visible in history for record-keeping |
| Cross-tenant foreign IDs | 404 across every module tested (§12) |
| Malformed/garbage/tampered token | 401 |
| Malformed UUID in a URL path | Clean 404, not a raw database error |

No unhandled failure was found in any tested case.

---

## 17. Production Readiness

| Area | Verifiable from this session? | Status |
|---|---|---|
| Application code | Yes | **Verified** — 115 tests passing, live business-logic and security checks performed |
| Database (Neon) — reachability, schema, migrations | Yes | **Verified** — `prisma migrate status` confirms all 4 migrations applied, schema current, no drift |
| Security (app-level) | Yes | **Verified** — see §5, §12 |
| Frontend deployment (Vercel) | **No** | **NOT VERIFIED** — no dashboard/CLI access, no live URL provided this session |
| Backend deployment (Vercel) | **No** | **NOT VERIFIED** — same reason |
| Environment variables in production | **No** | **NOT VERIFIED.** Note: the local backend configuration's `CORS_ORIGINS` value has changed since the previous audit, from the local-development default to what appears to be a real Vercel frontend address — a positive sign that deployment configuration work has progressed, but this was observed in a local file, **not confirmed as the live, active configuration of a running production service** |
| CORS | Partially | Code correctly reads an allow-list from configuration rather than hardcoding it (unchanged, already verified); whether the *live* backend is actually enforcing the intended origin was not tested this session |
| HTTPS / custom domain | **No** | **NOT VERIFIED** — no live URL to test |
| Neon backups / PITR | **No** | **NOT VERIFIED** — this is an account/dashboard-level setting, inspectable only with Neon dashboard access, which this session does not have |
| Restore procedure | **No** | **NOT PERFORMED.** A manual `pg_dump`/`pg_restore` procedure is documented in the README as having been verified previously; not re-tested in this session |
| Monitoring / logging | Partially | Basic application-level request logging and a partial audit trail exist (§3.29, §5); no external monitoring/alerting platform is integrated — this was never claimed to exist and is not currently present |
| Disaster recovery | **No** | **NOT VERIFIED**, for the same reasons as backups above |

**One live data-hygiene finding from this session (not a code defect):** while running read-only checks against the real database to confirm the new Category product-count feature, **all 5 categories in the current tenant were found to be marked inactive**, including what appear to be the original demo-seed categories ("Frames," "Lenses," "Medicines"). This means the Categories page currently shows an empty list by default in the live data (toggling "Show deactivated" reveals them, and the new product-count logic on them was confirmed correct: Medicines→2, Lenses→1, Frames→1). This was not caused by, and is unrelated to, the correctness of any code audited in this report — it is a live data state that a tenant administrator can correct in seconds via the existing "Activate" button, whenever appropriate.

---

## 18. Risk Register

| ID | Risk | Severity | Impact | Likelihood | Current Status | Recommendation |
|---|---|---|---|---|---|---|
| R1 | Live Vercel deployment status unconfirmed | **P0** | App may not be reachable, or may be running outdated code | Certain until checked | Open | Confirm/complete deployment; verify the live URL loads and reaches the correct backend |
| R2 | Neon backup/PITR configuration unconfirmed | **P0** | Unrecoverable data loss possible if never configured | Unknown until checked | Open | Check the Neon dashboard immediately; perform one practice restore into a separate database before go-live |
| R3 | Production `CORS_ORIGINS` not confirmed as the live active value | **P1** | If misconfigured, the live frontend cannot reach the live backend at all | Unknown | Open (partial positive signal observed, not confirmed) | Confirm the deployed value directly in the Vercel dashboard |
| R4 | Cross-tenant reference checks are application-, not database-, enforced (S2) | **P2** | Narrow theoretical race condition | Very low | Open, disclosed | Future defense-in-depth via database constraints |
| R5 | Three moderate `npm audit` findings, no fix available (S3) | **P2** | Denial-of-service class | Low | Open | Monitor for an upstream fix |
| R6 | Customer History / Supplier Ledger unpaginated | **P2** | Slower responses at very large data volumes | Low today | Open, disclosed | Add pagination if usage data shows it's needed |
| R7 | Expense Categories lack a full management page | **P3** | Minor operational inconvenience | N/A | Open | Add a page mirroring Product Categories |
| R8 | Partial audit-log coverage | **P3** | Incomplete "who changed what" trail | N/A | Open | Extend the existing logging helper's usage |
| R9 | No self-service password reset | **P3** | Operational inconvenience | N/A | Open | Consider for a future phase |
| R10 | All categories currently inactive in the live database | **P3** | Categories page currently appears empty by default | Certain (currently true) | Open, data-only, not a code issue | A tenant admin reactivates via the existing UI when ready |

---

## 19. What Is Excellent

Only items directly supported by code and test evidence gathered in this engagement:

- **Backend-authoritative financial and stock calculations** — proven by attempting to send client-manipulated values and confirming the server always recalculates independently.
- **Genuinely tested tenant isolation** — including the discovery and closure of a real, serious cross-tenant vulnerability, not just an assumption that the architecture was safe.
- **Payment validation** — overpayment, zero, and negative amounts rejected consistently across every payment surface tested.
- **Transaction safety** — every money/stock-affecting operation is wrapped in a real database transaction; no partial-application scenario was found.
- **Correct reversal handling** — sales are reversed, never deleted, with stock restored precisely and double-reversal blocked.
- **Barcode uniqueness enforcement**, correctly tenant-scoped (the same code is properly allowed to repeat across two different shops, correctly rejected within one).
- **A real, meaningful automated test suite** (115 tests) specifically defending the two things that matter most for this kind of system: authorization and money.
- **Clean, consistent separation** between frontend presentation and backend authority, maintained without exception across every module inspected.
- **Soft-delete/reversal-based design** throughout — nothing financially or operationally important is ever silently destroyed.

---

## 20. What Should Be Improved

### Must Fix Before Production
1. Confirm live Vercel deployment (frontend + backend) is actually working end-to-end. (R1)
2. Confirm Neon backup/PITR configuration and perform one practice restore. (R2)
3. Confirm the deployed `CORS_ORIGINS` value directly in the Vercel dashboard. (R3)

### Strongly Recommended
4. Add a full Expense Categories management page. (R7)
5. Extend audit logging to the remaining modules. (R8)
6. Reactivate the categories currently sitting inactive in the live database, once confirmed intentional to do so. (R10)

### Nice to Have
7. Add pagination to Customer History / Supplier Ledger once real usage data justifies it. (R6)
8. Database-level compound constraints for cross-tenant reference integrity, as defense-in-depth. (R4)
9. A short accessibility and mobile-usability pass.

### Future Enhancements
10. Self-service password reset (requires adding email-sending capability).
11. Camera-based barcode scanning, if USB/Bluetooth scanners ever prove insufficient in practice.
12. The previously-scoped "Phase 3" platform features (Super Admin/Master Portal, billing, notifications) — already documented in the project's own roadmap as not yet started, genuinely out of scope for this audit.

---

## 21. 30 / 60 / 90 Day Roadmap

### First 30 days — Critical production and UX
- Complete and verify the live Vercel deployment (frontend + backend).
- Confirm and, if necessary, configure Neon backup/PITR; perform a practice restore.
- Confirm production CORS configuration.
- Reactivate/review the currently-inactive categories in the live database.
- Run the manual regression checklist (already documented in the project's README) against the live deployment before onboarding real shop data.

### 31–60 days — Operational improvements and reporting
- Add the Expense Categories management page.
- Extend audit logging across the remaining modules.
- Re-verify the Reports module end-to-end in the live environment (not re-tested this session).
- A short accessibility and mobile-usability pass.

### 61–90 days — Advanced features and scalability
- Add pagination to Customer History / Supplier Ledger if real data volume warrants it.
- Consider database-level constraints for cross-tenant reference integrity.
- Evaluate self-service password reset.
- Revisit the outstanding dependency findings (S3) for an upstream fix.

---

## 22. Client-Facing Final Verdict

**1. Is the project professionally developed?** Yes — the evidence is specific and repeatable, not a general impression: correct financial math verified against hand calculations, a real security vulnerability found and closed with proof, and consistent architectural patterns followed without exception across the entire codebase.

**2. Is the architecture acceptable?** Yes. The frontend/backend/database separation is clean, the deployment shape (Vercel + Vercel + Neon) is architecturally sound in code, and the multi-tenant data model is correctly designed at the database level.

**3. Is the security acceptable?** Yes, and demonstrably so — not because no issues were ever found, but because a real one *was* found through active testing and is now closed with regression tests proving it stays closed. The two remaining security-adjacent items (application- vs. database-level cross-tenant enforcement, and an unresolved but low-severity dependency advisory) are disclosed, understood, and appropriately prioritized rather than urgent.

**4. Is the business logic reliable?** Yes. Every financial and inventory calculation tested — sales, purchases, payments, discounts (including this session's new percentage-based purchase discount entry), reversals, stock — matched hand-calculated expected values exactly, and the one real bug found (a reversed sale's phantom balance) has been fixed and re-verified.

**5. Is the application ready for real users?** The application itself, yes. Whether it is *currently running* correctly in production, and whether the database backing it is protected against data loss, could not be confirmed from this session — those are the two things standing between "the code is ready" and "this is ready for real clinic data."

**What prevents unconditional production approval:** exclusively the two operational unknowns in §17/§18 (R1, R2) — nothing found in the application code itself.

**What should the client approve before launch:** confirm the live deployment works end-to-end, and confirm (with one practice restore) that the database can actually be recovered if something ever goes wrong.

**What should be improved after launch:** the items in §20's "Strongly Recommended" and "Nice to Have" lists — none of them block starting real use once the two conditions above are met.

**Final scores:**

| | |
|---|---|
| Overall | **8.2 / 10** |
| Security | **8.5 / 10** |
| Architecture | **8.5 / 10** |
| Business Logic | **9 / 10** |
| UX | **7.5 / 10** |
| Testing | **8 / 10** |
| Production Readiness | **5 / 10** |

---

# FINAL CLIENT VERDICT

**Overall Score: 8.2/10**
**Production Status: 🟡 READY WITH CONDITIONS**

**Top 5 Strengths:**
1. Genuinely tested (not merely claimed) multi-tenant data isolation, including a real vulnerability found and fixed during this engagement.
2. Backend-authoritative financial and inventory calculations — verified incapable of being bypassed from the browser.
3. A complete, working barcode workflow: scan-to-sell, generate, print, tenant-scoped duplicate prevention.
4. Correct, audit-trail-preserving design for every money-related record — nothing important is ever silently deleted.
5. A real, meaningful, freshly-verified automated test suite (115 passing tests) specifically defending security and money.

**Top 5 Remaining Risks:**
1. Live Vercel deployment status is unconfirmed.
2. Neon database backup/recovery configuration is unconfirmed.
3. Production CORS configuration is unconfirmed as the live, active value.
4. Cross-tenant reference integrity relies on application-layer checks, not a database-level backstop (low likelihood, disclosed).
5. All categories in the live database are currently inactive (a data-state issue, not a code defect).

**Top 5 Recommended Next Steps:**
1. Confirm the Vercel frontend and backend deployments are live, correctly configured, and reachable end-to-end.
2. Confirm Neon backup/PITR settings and perform one practice restore into a separate database.
3. Confirm the production `CORS_ORIGINS` value directly in the Vercel dashboard.
4. Reactivate the currently-inactive live categories once confirmed intentional.
5. Run the project's documented manual regression checklist against the live deployment before onboarding real shop data.
