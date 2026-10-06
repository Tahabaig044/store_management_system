// The zero-configuration, zero-network default AI provider. It never calls
// an external service and never fabricates a number - it only composes
// plain-language phrasing around the deterministic facts it is handed by
// context.js/analytics.js. This is what makes the whole AI layer runnable
// (and fully testable) with no API key, no internet access, and no risk of
// an external provider inventing a figure that isn't backed by the tenant's
// actual data. A real hosted LLM can be registered as an additional
// provider later (see providers/provider.js) purely to improve phrasing -
// it would still be handed the same `facts` object and forbidden from
// inventing numbers not present in it.
function pct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'an unknown amount';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}
function money(n) {
  return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// answerIntent: composes a natural-language answer for one recognized
// intent from its facts. Every branch only ever reads `facts` - it never
// invents a number that isn't already there.
function answerIntent(intent, facts) {
  switch (intent) {
    case 'sales_comparison': {
      const { current, previous, changePercent } = facts;
      if (previous.saleCount === 0 && current.saleCount === 0) {
        return { text: 'There is no sales data in either period to compare yet.', confidence: 0.3 };
      }
      const direction = changePercent === null ? 'changed' : changePercent >= 0 ? 'grew' : 'declined';
      return {
        text: `Sales ${direction} ${changePercent === null ? '' : pct(changePercent) + ' '}to ${money(current.revenue)} from ${money(previous.revenue)} in the prior period (${current.saleCount} vs ${previous.saleCount} sales).`,
        confidence: 0.95,
      };
    }
    case 'branch_profitability': {
      const rows = facts.branches;
      if (rows.length === 0) return { text: 'No branch data is available for this period.', confidence: 0.3 };
      const top = rows[0];
      return {
        text: `${top.branchName} is the most profitable branch in this period with a gross profit of ${money(top.grossProfit)} on ${money(top.revenue)} in sales (${top.grossMarginPercent === null ? 'n/a' : top.grossMarginPercent.toFixed(1) + '%'} margin).`,
        confidence: 0.9,
      };
    }
    case 'product_margin': {
      const { mostProfitable, lowMargin } = facts;
      if (mostProfitable.length === 0) return { text: 'No product sales are recorded in this period.', confidence: 0.3 };
      const top3 = mostProfitable.slice(0, 3).map((p) => `${p.name} (${money(p.margin)})`).join(', ');
      const worst = lowMargin[0];
      return {
        text: `Best gross-margin products this period: ${top3}.${worst ? ` Lowest margin: ${worst.name} at ${worst.marginPercent === null ? 'n/a' : worst.marginPercent.toFixed(1) + '%'}.` : ''}`,
        confidence: 0.9,
      };
    }
    case 'receivables_overdue': {
      const rows = facts.rows;
      if (rows.length === 0) return { text: `No customers currently have payments overdue by ${facts.minDaysOverdue}+ days.`, confidence: 0.95 };
      const total = rows.reduce((s, r) => s + r.amountDue, 0);
      return {
        text: `${rows.length} customer(s) have payments overdue by ${facts.minDaysOverdue}+ days, totaling ${money(total)}. The most overdue is ${rows[0].customerName} at ${rows[0].daysOverdue} days (${money(rows[0].amountDue)}).`,
        confidence: 0.95,
      };
    }
    case 'low_stock_risk': {
      const rows = facts.rows;
      if (rows.length === 0) return { text: 'No products are currently at risk of running out soon.', confidence: 0.9 };
      const names = rows.slice(0, 5).map((r) => r.name).join(', ');
      return { text: `${rows.length} product(s) may run out soon, including: ${names}.`, confidence: 0.85 };
    }
    case 'slow_moving_stock': {
      const { items, totalCapitalTiedUp, windowDays } = facts;
      if (items.length === 0) return { text: `No products have gone unsold for ${windowDays}+ days.`, confidence: 0.9 };
      return {
        text: `${items.length} product(s) haven't sold in ${windowDays}+ days, tying up ${money(totalCapitalTiedUp)} in stock. Largest: ${items[0].name} (${money(items[0].capitalTiedUp)}).`,
        confidence: 0.85,
      };
    }
    case 'profit_decline': {
      const { netProfit, revenue, cogs, expenses } = facts;
      if (netProfit.change >= 0) {
        return { text: `Net profit actually improved by ${money(netProfit.change)} versus the prior period.`, confidence: 0.85 };
      }
      const drivers = [];
      if (revenue.change < 0) drivers.push(`revenue fell by ${money(-revenue.change)}`);
      if (cogs.change > 0) drivers.push(`cost of goods sold rose by ${money(cogs.change)}`);
      if (expenses.change > 0) drivers.push(`expenses rose by ${money(expenses.change)}`);
      return {
        text: `Net profit declined by ${money(-netProfit.change)} versus the prior period${drivers.length ? ', mainly because ' + drivers.join(' and ') + '.' : '.'}`,
        confidence: 0.8,
      };
    }
    case 'delayed_optical_jobs': {
      const rows = facts.rows;
      if (rows.length === 0) return { text: 'No optical jobs are past their expected delivery date.', confidence: 0.9 };
      return { text: `${rows.length} optical job(s) are past their expected delivery date, the oldest by ${rows[0].daysOverdue} day(s) (order ${rows[0].orderNumber}).`, confidence: 0.9 };
    }
    case 'supplier_price_changes': {
      const rows = facts.rows;
      if (rows.length === 0) return { text: 'No supplier price changes were detected in this window.', confidence: 0.8 };
      const top = rows[0];
      return { text: `${top.supplierName}'s price for ${top.productName} increased the most, ${pct(top.changePercent)} (from ${money(top.firstCost)} to ${money(top.lastCost)}).`, confidence: 0.85 };
    }
    case 'top_selling_products': {
      const rows = facts.bestSelling;
      if (rows.length === 0) return { text: 'No product sales are recorded in this period.', confidence: 0.3 };
      const top3 = rows.slice(0, 3).map((p) => `${p.name} (${p.quantitySold} sold)`).join(', ');
      return { text: `Fastest-selling products this period: ${top3}.`, confidence: 0.9 };
    }
    case 'top_debtors': {
      const rows = facts.rows;
      if (rows.length === 0) return { text: 'No customers currently owe an outstanding balance.', confidence: 0.9 };
      const total = rows.reduce((s, r) => s + r.amountDue, 0);
      return {
        text: `${rows.length} customer(s) owe a total of ${money(total)}. The largest balance is ${rows[0].customerName || 'a walk-in customer'} at ${money(rows[0].amountDue)}.`,
        confidence: 0.9,
      };
    }
    case 'expense_breakdown': {
      const rows = facts.rows;
      if (rows.length === 0) return { text: 'No expenses are recorded in this period.', confidence: 0.3 };
      const total = rows.reduce((s, r) => s + r.total, 0);
      const top3 = rows.slice(0, 3).map((r) => `${r.categoryName} (${money(r.total)})`).join(', ');
      return { text: `Biggest expense categories this period, totaling ${money(total)}: ${top3}.`, confidence: 0.9 };
    }
    case 'daily_brief':
      return { text: facts.summaryText, confidence: 0.9 };
    default:
      return { text: "I can answer questions about sales, profit, inventory, receivables/payables, procurement, and optical/clinic operations. Try one of the suggested questions.", confidence: 0.2 };
  }
}

async function ask({ intent, facts }) {
  return answerIntent(intent, facts);
}

module.exports = { ask };
