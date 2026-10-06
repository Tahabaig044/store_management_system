// Phase 0.2 Universal Product Architecture - domain/service layer.
//
// Centralizes the compatibility ("dual-write") logic between the legacy,
// Optical/Medical-coupled Product fields (`type`, `frameBrand`, `lensType`,
// `batchNumber`, etc. - all still the source of truth and still accepted/
// returned by the API unchanged) and the new universal structures
// (`productKind`, `brand`, `ProductOpticalAttributes`, `ProductMedicineAttributes`).
//
// Per docs/phase0-2-architecture-package.md ADR-3, this phase does NOT drop
// or stop writing the legacy columns - it keeps them as the source of truth
// and additionally populates the new extension tables from them, so existing
// consumers (8 backend files, 4 frontend files - see
// docs/phase0-2-entity-map-and-field-mapping.md) keep working unmodified
// while new code can read the universal shape.
//
// IMPORTANT: this module was written before `npx prisma generate` could be
// run in this session (blocked by sandbox permissions - see the Phase 0.2
// implementation report). It will not execute correctly until the Prisma
// Client is regenerated from the updated schema.prisma and the migration in
// backend/prisma/migrations/20260917120000_phase0_2_universal_product_architecture/
// has been applied to the target database.

const OPTICAL_KIND_BY_LEGACY_TYPE = {
  FRAME: 'FRAME',
  LENS: 'LENS',
};

const PRODUCT_KINDS = ['PHYSICAL_GOOD', 'SERVICE'];

/**
 * Derives the universal classification implied by a legacy `type` value.
 * No legacy type maps to SERVICE - that is new capability with no legacy
 * data (see docs/phase0-2-architecture-package.md, Classification &
 * Legacy Mapping Specification).
 */
function classifyLegacyType(type) {
  return {
    productKind: 'PHYSICAL_GOOD',
    opticalKind: OPTICAL_KIND_BY_LEGACY_TYPE[type] || null,
    isMedicine: type === 'MEDICINE',
  };
}

/**
 * Prisma `include` fragment for attaching the new extension relations to a
 * Product read (list/getOne). Reused by every route that returns a product.
 */
const PRODUCT_EXTENSIONS_INCLUDE = {
  opticalAttributes: true,
  medicineAttributes: true,
};

/**
 * Given the full legacy-shaped product field set (as already validated by
 * products.routes.js's createSchema/updateSchema), upserts the appropriate
 * industry-extension row inside the caller's transaction.
 *
 * Deliberately conservative for this phase: if a product's `type` changes
 * AWAY FROM an industry type (e.g. FRAME -> GENERAL), the previously-created
 * extension row is left in place rather than deleted, to avoid any
 * destructive action during the compatibility transition (see ADR-3). This
 * is a known, documented limitation to revisit only once the legacy `type`
 * field itself is deprecated (Implementation Sequence step 10, a separate,
 * later, explicitly-approved step - not part of this phase).
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {{tenantId: string, productId: string, type?: string,
 *   frameBrand?: string, frameModel?: string, frameColor?: string, frameSize?: string,
 *   lensType?: string, lensMaterial?: string, lensCoating?: string,
 *   batchNumber?: string, expiryDate?: Date}} fields
 */
async function syncExtensionsFromLegacyFields(tx, fields) {
  const { tenantId, productId, type } = fields;
  const { opticalKind, isMedicine } = classifyLegacyType(type);

  if (opticalKind) {
    await tx.productOpticalAttributes.upsert({
      where: { productId },
      create: {
        tenantId,
        productId,
        opticalKind,
        frameBrand: fields.frameBrand,
        frameModel: fields.frameModel,
        frameColor: fields.frameColor,
        frameSize: fields.frameSize,
        lensType: fields.lensType,
        lensMaterial: fields.lensMaterial,
        lensCoating: fields.lensCoating,
      },
      update: {
        opticalKind,
        frameBrand: fields.frameBrand,
        frameModel: fields.frameModel,
        frameColor: fields.frameColor,
        frameSize: fields.frameSize,
        lensType: fields.lensType,
        lensMaterial: fields.lensMaterial,
        lensCoating: fields.lensCoating,
      },
    });
  }

  if (isMedicine) {
    await tx.productMedicineAttributes.upsert({
      where: { productId },
      create: {
        tenantId,
        productId,
        batchNumber: fields.batchNumber,
        expiryDate: fields.expiryDate,
      },
      update: {
        batchNumber: fields.batchNumber,
        expiryDate: fields.expiryDate,
      },
    });
  }
}

/**
 * Resolves the `productKind` to persist on the Product row itself: respects
 * an explicit caller-supplied value (new capability, e.g. creating a
 * SERVICE product), otherwise derives it from the legacy `type` per the
 * Classification Mapping (always PHYSICAL_GOOD for today's four legacy
 * values).
 */
function resolveProductKind({ productKind, type }) {
  if (productKind && PRODUCT_KINDS.includes(productKind)) return productKind;
  return classifyLegacyType(type).productKind;
}

module.exports = {
  PRODUCT_KINDS,
  PRODUCT_EXTENSIONS_INCLUDE,
  classifyLegacyType,
  syncExtensionsFromLegacyFields,
  resolveProductKind,
};
