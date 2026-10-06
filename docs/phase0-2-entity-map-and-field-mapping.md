# Phase 0.2 — Current vs Target Entity Map, Consumer Inventory & Legacy Field Mapping Matrix

Companion to [`phase0-2-architecture-package.md`](./phase0-2-architecture-package.md). All evidence below is from direct inspection of the current working tree (re-verified this pass, not carried forward assumptions).

---

## 1. Current Entity (unchanged, for reference)

```
model Product {
  id, tenantId, categoryId?
  type              ProductType @default(GENERAL)   // GENERAL | MEDICINE | FRAME | LENS
  name, sku?, barcode?, description?
  purchasePrice, sellingPrice, stockQuantity, lowStockThreshold   (Decimal)
  unit              String @default("pcs")
  frameBrand?, frameModel?, frameColor?, frameSize?               (String)
  lensType?, lensMaterial?, lensCoating?                          (String)
  batchNumber?      String
  expiryDate?       DateTime
  isActive, archivedAt, createdAt, updatedAt
  [8 line-item relations]
}
enum ProductType { GENERAL, MEDICINE, FRAME, LENS }
```
Source: `backend/prisma/schema.prisma:214-219,237-290`.

## 2. Target Entity (proposed — see ADRs in the architecture package for rationale)

```
model Product {
  ...all current fields UNCHANGED and RETAINED...
  productKind       ProductKind @default(PHYSICAL_GOOD)   // NEW
  brand             String?                                // NEW
  opticalAttributes ProductOpticalAttributes?               // NEW relation
  medicineAttributes ProductMedicineAttributes?             // NEW relation
  variants          ProductVariant[]                        // NEW relation
}
enum ProductKind { PHYSICAL_GOOD, SERVICE }                  // NEW

model ProductOpticalAttributes {
  id, tenantId, productId (unique FK, cascade)
  opticalKind FRAME | LENS | CONTACT_LENS | ACCESSORY
  frameBrand?, frameModel?, frameColor?, frameSize?
  lensType?, lensMaterial?, lensCoating?
}                                                              // NEW table

model ProductMedicineAttributes {
  id, tenantId, productId (unique FK, cascade)
  batchNumber?, expiryDate?
}                                                              // NEW table

model ProductVariant {
  id, tenantId, productId (FK, cascade)
  name, sku?, barcode?, priceOverride?, stockQuantity?, isActive
}                                                              // NEW table
```

Nothing in the "current" section is removed, renamed, or retyped. Everything in "target" beyond the current section is additive.

---

## 3. Full Product Consumer Inventory (re-verified this pass via direct grep + file reads)

### Backend — consumers of `ProductType` / the 9 optical-medicine columns

| # | File:line | What it does | Migration impact |
|---|---|---|---|
| 1 | `backend/src/modules/products/products.routes.js:20,24,34-42` | Defines `PRODUCT_TYPES` enum + zod validation schema accepting `type` + all 9 fields (all already `.optional()`) | Must add `productKind`/`brand` to the schema alongside existing fields; existing fields/behavior unchanged |
| 2 | `backend/src/modules/reports/reports.routes.js:69` | `/inventory` report passes through `type: p.type` in its output rows | Add `productKind` alongside; keep `type` in output for compatibility |
| 3 | `backend/src/modules/reports/reports.routes.js:152-172` (approx.) | `/medicine-expiry` report: hard-filters `type: 'MEDICINE'`, outputs `batchNumber`/`expiryDate` | Adapter must resolve "is this a medicine" via `ProductMedicineAttributes` presence OR legacy `type='MEDICINE'` (dual-check during transition) |
| 4 | `backend/src/modules/dashboard/dashboard.routes.js:53,67,222,316` | Base dashboard "Expiring Medicines" widget — filters directly by `expiryDate` presence (not by `type`) | No `type`/`productKind` dependency at all — purely `expiryDate`-driven; low migration risk, but note it doesn't actually check `type==='MEDICINE'` today (a pre-existing minor inconsistency, not this phase's concern) |
| 5 | `backend/src/modules/ai/analytics.js:233-241` (`expiryRisk`) | Same `expiryDate`/`batchNumber`-driven query feeding AI insights | Same as #4 — no `type` dependency |
| 6 | `backend/src/modules/ai/recommendations.js:~100` | Expiry recommendation text consumes `batchNumber` | Read-only consumer of a field that remains in place; no change required in this phase |
| 7 | `backend/src/modules/communication/scheduled.routes.js:101,109` | `EXPIRY_APPROACHING` automation scan — consumes `batchNumber`/`expiryDate` | Same — no change required in this phase |
| 8 | `backend/src/modules/mobile/dashboardService.js:462` | Owner Mobile dashboard filter: `businessAreas: ['GENERAL','MEDICINE','FRAME','LENS']` | Currently unreachable (routes unmounted per Phase 0.1) — no live consumer today; update when Owner Mobile resumes, not part of this phase |

### Backend — confirmed NOT consumers (reduces blast radius)

| Module | Finding |
|---|---|
| `sales.routes.js` | Zero references to `.type` on Product — sale line items are fully type-agnostic already |
| `purchases.routes.js` | Same — zero `.type` references |
| `opticalOrders.routes.js` | Explicitly **not linked to Product at all** (own code comment, line 12: "Optical orders aren't linked to tracked Product/stock records") — frame/lens description on `OpticalOrder` is independent free text, unrelated to `Product.frameBrand` etc. |
| `warehouses/*`, `procurement/*`, `inventory.routes.js` | No `.type`/optical-medicine field references found |

### Frontend — consumers

| # | File:line | What it does | Migration impact |
|---|---|---|---|
| 9 | `frontend/src/pages/products/Products.jsx:56,111,312-314,378,443-447,512-547` | Full CRUD form: type filter dropdown, create/edit form type dropdown, conditional FRAME/LENS/MEDICINE field blocks, table column, query-string-driven filter (`?type=MEDICINE`) | Primary UI surface to update — add `enabledIndustryPacks`-aware conditional rendering (see Frontend UI Architecture doc); keep `type` field/behavior during transition |
| 10 | `frontend/src/pages/reports/Reports.jsx:90,275` | "Medicine Expiry" report tab renders `batchNumber`/`expiryDate` columns | No change required — reads report API output, which stays compatible |
| 11 | `frontend/src/pages/dashboard/Dashboard.jsx:~157` | "Expiring Medicines" list widget renders `expiryDate` | No change required |
| 12 | `frontend/src/pages/dashboard/CommandCenter.jsx:504` | Stock-alert box "Expiring Medicines (30 days)" + deep link `/products?type=MEDICINE` | No change required — link target (`Products.jsx`'s `type` filter) remains valid during transition |

### Frontend — confirmed NOT a real consumer (cosmetic only)

| File | Finding |
|---|---|
| `frontend/src/pages/categories/Categories.jsx:15-20,238-242` | `<datalist>` suggestion strings including "Frames"/"Contact Lenses"/"Prescription Lenses" — **not** backed by `Product.type` or any code dependency; pure UX text suggestion. No migration action needed. |

**Total: 8 real backend consumers, 4 real frontend consumers, 1 currently-dormant consumer (Owner Mobile), plus 2 confirmed non-consumers per platform that reduce the actual migration surface below what the raw grep-hit count might suggest.**

---

## 4. Legacy Optical/Medical Field Mapping Matrix (spec §15 required deliverable)

| Legacy field | Classification | Target location | Rationale |
|---|---|---|---|
| `Product.type` | Derived/Deprecated (retained during transition) | Stays on `Product`, dual-written; superseded by `productKind` + extension presence for new code | Cannot be dropped until all 12 consumers above are migrated and you approve deprecation (Implementation Sequence step 10) |
| `frameBrand` | Industry Extension (Optical) | `ProductOpticalAttributes.frameBrand` | Optical-specific *when tied to a frame*; note the universal `brand` field (ADR-5) is the preferred general concept going forward |
| `frameModel` | Industry Extension (Optical) | `ProductOpticalAttributes.frameModel` | Frame-specific, no generic equivalent |
| `frameColor` | Industry Extension (Optical) | `ProductOpticalAttributes.frameColor` | Frame-specific |
| `frameSize` | Industry Extension (Optical) | `ProductOpticalAttributes.frameSize` | Frame-specific |
| `lensType` | Industry Extension (Optical) | `ProductOpticalAttributes.lensType` | Lens-specific |
| `lensMaterial` | Industry Extension (Optical) | `ProductOpticalAttributes.lensMaterial` | Lens-specific |
| `lensCoating` | Industry Extension (Optical) | `ProductOpticalAttributes.lensCoating` | Lens-specific |
| `batchNumber` | Industry Extension (Medicine/regulated-inventory) | `ProductMedicineAttributes.batchNumber` | Per spec's own example direction |
| `expiryDate` | Industry Extension (Medicine/regulated-inventory) | `ProductMedicineAttributes.expiryDate` | Per spec's own example direction |

No field was moved "merely because it appears reusable" (per spec §15's caution) — `frameBrand` is the one field with a plausible universal generalization, and it is handled by *adding* a new universal `brand` field (ADR-5) rather than reclassifying `frameBrand` itself, which stays correctly owned by the Optical pack for backward compatibility.

**Every legacy field above has an explicit target — none are left as "Owner Decision" or "unclear."**
