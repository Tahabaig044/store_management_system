// Phase 2.4: ledger effect of stock changes that are NOT a purchase or a sale.
//
// Before this, opening stock, count corrections and direct warehouse receipts/dispatches
// changed Product.stockQuantity (and therefore what the business owns) without any
// journal entry, so the Inventory account drifted from the stock actually on hand.
//
//   quantity > 0:  Dr Inventory              Cr Opening Balance Equity   (opening stock)
//                                             Cr Inventory Adjustments    (any other gain)
//   quantity < 0:  Dr Inventory Adjustments  Cr Inventory                (loss / write-off)
//
// Valued at the product's current purchase price - the same basis a sale uses for COGS -
// so buying, selling and adjusting the same product stay consistent. Services and
// zero-cost items carry no inventory value and post nothing. Stock moves BETWEEN locations
// (stock transfers) change no ownership and correctly post nothing.
const { postJournalEntry, getSystemAccountId, round2 } = require('./ledger');

async function postInventoryAdjustment(tx, { tenantId, branchId, product, quantity, kind = 'ADJUSTMENT', memo, sourceId, postedById, date }) {
  if (!quantity || product.productKind === 'SERVICE') return null;
  const value = round2(Math.abs(Number(quantity)) * Number(product.purchasePrice || 0));
  if (value <= 0) return null;

  const [inventoryId, offsetId] = await Promise.all([
    getSystemAccountId(tx, tenantId, 'INVENTORY'),
    getSystemAccountId(tx, tenantId, kind === 'OPENING' ? 'OPENING_BALANCE_EQUITY' : 'INVENTORY_ADJUSTMENT'),
  ]);
  const gain = Number(quantity) > 0;
  return postJournalEntry(tx, {
    tenantId,
    branchId: branchId || null,
    date,
    sourceType: 'INVENTORY_ADJUSTMENT',
    sourceId,
    memo: memo || `${kind === 'OPENING' ? 'Opening stock' : 'Stock adjustment'}: ${product.name}`,
    postedById,
    lines: gain
      ? [{ accountId: inventoryId, debit: value }, { accountId: offsetId, credit: value }]
      : [{ accountId: offsetId, debit: value }, { accountId: inventoryId, credit: value }],
  });
}

module.exports = { postInventoryAdjustment };
