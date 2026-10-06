// Phase 0.6: business logic extracted out of purchases.routes.js, which
// previously held these as inline top-level functions. Purely a relocation -
// no logic changed - demonstrating the service-layer separation pattern
// (route handlers stay thin: parse -> validate -> call service -> respond)
// already used by accounting/ledger.js and products/productService.js.
const { NotFoundError } = require('../../utils/errors');
const { postJournalEntry, getSystemAccountId, getMoneyAccountId } = require('../accounting/ledger');

// Case A: created and received in the same step (receiveImmediately=true,
// the common "pay on receipt" shop pattern) - whatever was paid goes
// straight to Cash/Bank, only the unpaid remainder becomes Accounts Payable.
async function postImmediateReceiptEntry(tx, { tenantId, branchId, purchase, paymentMethod, postedById }) {
  const goodsCost = Number(purchase.subtotal) - Number(purchase.discount);
  const tax = Number(purchase.tax);
  const total = Number(purchase.total);
  const amountPaid = Number(purchase.amountPaid);
  const payableRemainder = total - amountPaid;

  const [inventoryAccountId, inputTaxAccountId, cashBankAccountId, payableAccountId] = await Promise.all([
    goodsCost > 0 ? getSystemAccountId(tx, tenantId, 'INVENTORY') : null,
    tax > 0 ? getSystemAccountId(tx, tenantId, 'INPUT_TAX') : null,
    amountPaid > 0 ? getMoneyAccountId(tx, tenantId, paymentMethod) : null,
    payableRemainder > 0 ? getSystemAccountId(tx, tenantId, 'ACCOUNTS_PAYABLE') : null,
  ]);

  const lines = [];
  if (goodsCost > 0) lines.push({ accountId: inventoryAccountId, debit: goodsCost, supplierId: purchase.supplierId });
  if (tax > 0) lines.push({ accountId: inputTaxAccountId, debit: tax, supplierId: purchase.supplierId });
  if (amountPaid > 0) lines.push({ accountId: cashBankAccountId, credit: amountPaid, supplierId: purchase.supplierId });
  if (payableRemainder > 0) lines.push({ accountId: payableAccountId, credit: payableRemainder, supplierId: purchase.supplierId });

  if (lines.length >= 2) {
    await postJournalEntry(tx, {
      tenantId,
      branchId,
      date: purchase.receivedAt || new Date(),
      sourceType: 'PURCHASE',
      sourceId: purchase.id,
      memo: `Purchase ${purchase.purchaseNumber} received`,
      postedById,
      lines,
    });
  }
}

// Case B: a DRAFT purchase is received later via /receive. If it already had
// an advance payment posted at creation time (see postAdvanceEntry below),
// that advance is cleared against Accounts Payable here rather than
// double-counted as still owing.
async function postDeferredReceiptEntry(tx, { tenantId, branchId, purchase, postedById }) {
  const goodsCost = Number(purchase.subtotal) - Number(purchase.discount);
  const tax = Number(purchase.tax);
  const total = Number(purchase.total);
  const advance = Math.min(Number(purchase.amountPaid), total);

  const [inventoryAccountId, inputTaxAccountId, payableAccountId, advanceAccountId] = await Promise.all([
    goodsCost > 0 ? getSystemAccountId(tx, tenantId, 'INVENTORY') : null,
    tax > 0 ? getSystemAccountId(tx, tenantId, 'INPUT_TAX') : null,
    getSystemAccountId(tx, tenantId, 'ACCOUNTS_PAYABLE'),
    advance > 0 ? getSystemAccountId(tx, tenantId, 'ADVANCE_TO_SUPPLIERS') : null,
  ]);

  const lines = [];
  if (goodsCost > 0) lines.push({ accountId: inventoryAccountId, debit: goodsCost, supplierId: purchase.supplierId });
  if (tax > 0) lines.push({ accountId: inputTaxAccountId, debit: tax, supplierId: purchase.supplierId });
  lines.push({ accountId: payableAccountId, credit: total, supplierId: purchase.supplierId });
  if (advance > 0) {
    lines.push({ accountId: payableAccountId, debit: advance, supplierId: purchase.supplierId });
    lines.push({ accountId: advanceAccountId, credit: advance, supplierId: purchase.supplierId });
  }

  if (lines.length >= 2) {
    await postJournalEntry(tx, {
      tenantId,
      branchId,
      date: new Date(),
      sourceType: 'PURCHASE',
      sourceId: purchase.id,
      memo: `Purchase ${purchase.purchaseNumber} received`,
      postedById,
      lines,
    });
  }
}

// A payment recorded on a DRAFT (not-yet-received) purchase is a genuine
// prepayment - the cash has left the business, but there's no Payable or
// Inventory yet to apply it against.
async function postAdvanceEntry(tx, { tenantId, branchId, purchase, paymentMethod, postedById }) {
  const amountPaid = Number(purchase.amountPaid);
  if (amountPaid <= 0) return;
  const [advanceAccountId, cashBankAccountId] = await Promise.all([
    getSystemAccountId(tx, tenantId, 'ADVANCE_TO_SUPPLIERS'),
    getMoneyAccountId(tx, tenantId, paymentMethod),
  ]);
  await postJournalEntry(tx, {
    tenantId,
    branchId,
    date: purchase.createdAt || new Date(),
    sourceType: 'PAYMENT',
    sourceId: purchase.id,
    memo: `Advance payment for purchase ${purchase.purchaseNumber}`,
    postedById,
    lines: [
      { accountId: advanceAccountId, debit: amountPaid, supplierId: purchase.supplierId },
      { accountId: cashBankAccountId, credit: amountPaid, supplierId: purchase.supplierId },
    ],
  });
}

async function receivePurchaseStock(tx, purchase, userId) {
  for (const item of purchase.items) {
    // Tenant-scoped even though these items were already validated at creation
    // time - this is the function that actually mutates stock, so it must not
    // trust its caller alone to have enforced that boundary.
    const product = await tx.product.findFirst({ where: { id: item.productId, tenantId: purchase.tenantId } });
    if (!product) throw new NotFoundError(`Product ${item.productId} not found`);
    // Atomic increment (not read-current-then-blind-SET): receiving stock is an
    // unconditional addition, so a concurrent decrement/increment on the same
    // product can never make this operation invalid - only a lost update to guard
    // against, which { increment } avoids by never overwriting a stale read.
    const updated = await tx.product.update({
      where: { id: product.id },
      data: { stockQuantity: { increment: Number(item.quantity) } },
    });
    await tx.inventoryTransaction.create({
      data: {
        tenantId: purchase.tenantId,
        productId: product.id,
        type: 'PURCHASE_RECEIVE',
        quantity: item.quantity,
        balanceAfter: updated.stockQuantity,
        reference: purchase.id,
        createdById: userId,
      },
    });
  }
}

module.exports = { postImmediateReceiptEntry, postDeferredReceiptEntry, postAdvanceEntry, receivePurchaseStock };
