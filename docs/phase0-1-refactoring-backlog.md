# Phase 0.1 — Refactoring Backlog

Every item below traces to a specific finding in one of the domain audit documents. Nothing here has been implemented — per the Phase 0.1 spec, this phase produces the backlog only; fixing these is Phase 0.1-adjacent hardening work or later-phase scope, to be scheduled and approved separately from Phase 0.2's architecture work.

Priority: **P0** = should happen before/independent of Phase 0.2 (safety or active security-relevant gap). **P1** = should inform or precede Phase 0.2 design. **P2** = can happen alongside Phase 0.2. **P3** = defer to Phase 0.3+ or opportunistic cleanup.

---

## P0 — Immediate / Independent of Phase 0.2

| # | Item | Risk if deferred | Dependency | Evidence |
|---|---|---|---|---|
| 1 | Point `backend/.env` (and CI) at a disposable local/test database; remove or clearly gate the live Neon `DATABASE_URL` from ever being the default for `npm test` | Accidental `npm test` run writes throwaway tenants/sales/journal entries into a production-adjacent database | None — a local Postgres is already available at `D:\pgsql-portable` per this project's standing environment note | Test matrix §Critical 3 |
| 2 | Product-owner decision on the Owner Mobile feature: resume (commit everything, apply the pending migration, remount the 6 routers) or formally shelve it | Continued bit-rot; risk that unrelated future work accidentally deletes or corrupts the uncommitted `android/` tree or `backend/src/modules/mobile|push/*` | Requires a human decision, not an engineering task — this audit surfaces it, doesn't resolve it | Android map §0; Finding register #9 |
| 3 | Introduce one shared, enforced branch-scoping convention and apply it to all 9 identified gaps: Warehouses, Stock Transfers, entire Procurement module, `journal.routes.js`, 17 accounting reports, 8 core Reports endpoints + Payments-list + Inventory-transactions-list, Communication reports, Clinical reports, Doctors endpoints | Recurring cross-branch data exposure / stock-integrity risk; will keep recurring in every new module written until this becomes structural rather than a per-author habit | None — can reuse the existing `middleware/branchScope.js` helpers already proven in `sales.routes.js`/`purchases.routes.js` | Finding register #5,6,10-16 |
| 4 | Fix `Message.branchId` never being populated (`communication/queue.js`/`automation.js`) so the branch-scope check on `messages.routes.js` actually does something, and add branch-scoping to `communication/reports.routes.js` in the same change (fixing one without the other turns the reports endpoint into a new cross-branch leak) | Currently fails closed (empty results) — functional bug, not a live leak, but fixing branchId alone without also fixing reports.routes.js would flip it into a real leak | Do items together, not separately | Finding register #13 |

## P1 — Should inform or precede Phase 0.2 (Universal Product Architecture)

| # | Item | Risk if deferred | Dependency | Evidence |
|---|---|---|---|---|
| 5 | Design the Universal Product Architecture: generic `Product` core (SKU, name, price, tax, unit) + a tenant/industry-configurable attributes mechanism, replacing the current hard-coded `type` enum + 9 optical/pharmacy columns | This **is** Phase 0.2's central problem statement — deferring analysis further blocks a clean start | This audit's DB map + feature matrix (already delivered) | Architecture Risk #1; DB map, Product entity |
| 6 | Add concurrency/race-condition tests for stock-affecting flows (sale, purchase-receive, stock-adjustment, transfer) before any refactor touches those code paths | A refactor could silently introduce or hide a double-sell/negative-stock race with no test to catch it | None | Finding register #3; Test matrix §Critical 2 |
| 7 | Repair the Warehouses/StockTransfers/Procurement/Journal branch-scope gaps (see P0-3) with actual code changes, not just a convention decision | Same as P0-3 | P0-3's convention/helper design | Finding register #5,6 |
| 8 | Add test coverage for `GET /api/payments`, `/api/reports/*` (core), and `/api/inventory/transactions` — currently zero or near-zero assertions on their actual output correctness | Silent regressions in reconciliation-critical read paths would go undetected | None | Test matrix §High 5,6,10 |

## P2 — Alongside Phase 0.2

| # | Item | Risk if deferred | Dependency | Evidence |
|---|---|---|---|---|
| 9 | Split `AutomationEvent`/`TemplateType` vertical-specific enum values (7/18 and 9/15 respectively) out into tenant/industry configuration rather than fixed Prisma enums | Blocks adding a second industry pack without a schema migration | Should follow whatever configuration mechanism Phase 0.2 designs for Product, so both use one consistent pattern | Architecture Risk #3; DB map §A4 |
| 10 | Decide on and (if adopted) implement a unified generic Order/Document header+line-item pattern to replace the six independent implementations (`Sale`, `Purchase`, `PurchaseOrder`, `PurchaseRequest`, `OpticalOrder`, `StockTransfer`) | Continued duplication cost — every future document type is a full new table pair, not configuration | Depends on Phase 0.2/0.3 architecture direction; this is a bigger call than Product alone and may reasonably be deferred further if the cost/benefit doesn't hold up | Architecture Risk #2; DB map §A1 |
| 11 | Standardize on one polymorphic-reference pattern (`Payment`'s multi-FK vs. `JournalEntry`'s `sourceType`+`sourceId`) for new code going forward | Growing inconsistency as more polymorphic relations get added | Phase 0.2 architecture decision | Architecture Risk #4; DB map §A3 |
| 12 | Repair actor-FK integrity: add real `User` relations to the ~12 bare-string `*ById` fields (`PurchaseOrder.createdById/approvedById`, `StockTransfer`'s four actor fields, `GoodsReceipt.receivedById`, `AiInsight.acknowledgedById/dismissedById`, `AiForecast.generatedById`, `Appointment/Examination/ClinicalPrescription/AutomationRule.createdById`) | Cannot reliably join/audit "who did this" for roughly half the schema; a deleted user silently orphans these references | None | DB map §A5 |
| 13 | Add direct `tenantId` columns (or an explicit documented exception list) to the 16 tables currently relying purely on parent-join scoping (`SaleItem`, `WarehouseStock`, `JournalLine`, `Prescription`, etc.) | Zero schema-level defense-in-depth against a future raw query/report forgetting to join through the parent | None — purely additive, low-risk migration | Finding register #1; DB map §Cross-Cutting B |

## P3 — Defer to Phase 0.3+ / opportunistic

| # | Item | Risk if deferred | Dependency | Evidence |
|---|---|---|---|---|
| 14 | Add `ProtectedRoute` role guards to `/products`, `/customers`, `/suppliers`, `/branches` (currently reachable by any authenticated role via direct URL despite sidebar hiding) | Low-severity access-control inconsistency; would compound if left until a Tenant Branding/RBAC-config pass | None | Finding register #17 |
| 15 | Consolidate hard-coded hex colors in `Dashboard.jsx`/`CommandCenter.jsx`/`Products.jsx` (barcode print) into the existing CSS custom-property theme system in `index.css` | A future Tenant Branding Engine that only swaps CSS variables won't actually retheme these two high-traffic screens | None | UI map §4 |
| 16 | Extract the `opticalJobs` and "Expiring Medicines" dashboard widgets behind a module-contribution mechanism instead of hard-coding them into the two universal dashboard endpoints | Every non-optical tenant pays the query cost and sees empty blocks | Depends on however Phase 0.2/0.3 decides Industry Modules contribute UI | UI map §3; Architecture Risk #7 |
| 17 | Centralize 4 duplicated patterns identified in the core API audit: sequential document-number generation (3 near-identical implementations), threshold-gated-approval checks (4 near-identical implementations), ad hoc foreign-key ownership checks (repeated at ~15 call sites), and pagination boilerplate (repeated at ~9 call sites) | Ongoing maintenance cost; each duplicate is a place a future fix could be applied inconsistently | None | API map core §Duplicated Logic 1-4 |
| 18 | Quarantine or repair the 69-test Owner-Mobile backend test suite (currently targets unmounted routes and would fail wholesale if run) so it stops implying coverage that doesn't exist | Misleading confidence for anyone who runs `npm test` without reading `app.js`'s mount comments first | Depends on the P0-2 Owner Mobile product decision | Test matrix §Critical 1 |
| 19 | Add a timing-safe (constant-cost) response path to `portal/otpAuth.routes.js`'s `request-otp` for non-existent customers, to fully close the phone-number-enumeration side channel the generic-response-body design already mostly prevents | Low — theoretical enumeration via response-time analysis only | None | Clinical/AI/Portal map §5.3 |
| 20 | Add a dedicated `users.test.js`/`settings.test.js`, and a non-admin-caller test for `PUT /api/settings/:key`'s TENANT_ADMIN-only restriction | Both modules are adequately covered as test *helpers* today but have no test asserting their own contract directly | None | Test matrix §Medium 8,14 |

---

## Explicitly out of scope for this backlog (per Phase 0.1 developer rules)

- No item here proposes removing or weakening working Optical/Medical functionality.
- No item here proposes a destructive database migration.
- Items 5 and 10 are architecture *decisions* for Phase 0.2/0.3 to make, not pre-approved refactors — they are listed so the decision-makers have the evidence, not as a mandate to implement.
