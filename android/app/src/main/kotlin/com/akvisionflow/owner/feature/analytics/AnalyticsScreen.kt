package com.akvisionflow.owner.feature.analytics

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.akvisionflow.owner.core.network.dto.DashboardInventoryResponse
import com.akvisionflow.owner.core.network.dto.DashboardCashResponse
import com.akvisionflow.owner.core.network.dto.DashboardProfitResponse
import com.akvisionflow.owner.core.network.dto.DashboardPurchasesResponse
import com.akvisionflow.owner.core.network.dto.DashboardReceivablesResponse
import com.akvisionflow.owner.core.network.dto.DashboardSalesResponse
import com.akvisionflow.owner.core.ui.components.DashboardFilterControls
import com.akvisionflow.owner.core.ui.components.SimpleBarChart
import com.akvisionflow.owner.core.util.Formatting

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AnalyticsScreen(
    viewModel: AnalyticsViewModel,
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()

    Scaffold(
        modifier = modifier,
        topBar = { TopAppBar(title = { Text("Analytics") }) },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            DashboardFilterControls(
                filters = uiState.filters,
                filterOptions = uiState.filterOptions,
                onRangeSelected = viewModel::setRange,
                onCustomRangeSelected = { from, to -> viewModel.setRange(com.akvisionflow.owner.core.filters.DashboardRange.CUSTOM, from, to) },
                onBranchSelected = viewModel::setBranch,
                onCategorySelected = viewModel::setCategory,
                onBusinessAreaSelected = viewModel::setBusinessArea,
                onCompanySelected = viewModel::setCompany,
            )

            when {
                uiState.isLoading && uiState.sales == null -> {
                    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator()
                    }
                }
                uiState.errorMessage != null && uiState.sales == null -> {
                    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(uiState.errorMessage ?: "", color = MaterialTheme.colorScheme.error)
                        Button(onClick = viewModel::retry, modifier = Modifier.padding(top = 12.dp)) { Text("Retry") }
                    }
                }
                else -> {
                    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        uiState.sales?.let { sales -> item { SalesSection(sales) } }
                        uiState.profit?.let { profit -> item { ProfitSection(profit) } }
                        uiState.receivables?.let { receivables -> item { ReceivablesSection(receivables) } }
                        uiState.purchases?.let { purchases -> item { PurchasesSection(purchases) } }
                        uiState.cash?.let { cash -> item { CashSection(cash) } }
                        uiState.inventory?.let { inventory -> item { InventorySection(inventory) } }
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            androidx.compose.foundation.layout.Spacer(Modifier.padding(top = 8.dp))
            content()
        }
    }
}

@Composable
private fun SalesSection(sales: DashboardSalesResponse) {
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        SectionCard("Sales Trend") {
            SimpleBarChart(values = sales.trend.map { it.total.toFloat() })
            Text(
                "Revenue: ${Formatting.money(sales.totals.revenue)}  •  Transactions: ${sales.totals.saleCount}  •  Avg: ${sales.totals.averageTransactionValue?.let { Formatting.money(it) } ?: "—"}",
                style = MaterialTheme.typography.bodySmall,
            )
            Text(
                "vs previous period: ${Formatting.percent(sales.comparison.changePercent)}",
                style = MaterialTheme.typography.bodySmall,
            )
        }

        SectionCard("Sales by Branch") {
            sales.byBranch.take(5).forEach { row ->
                LabelValueRow(row.branchName, Formatting.money(row.total))
            }
        }

        SectionCard("Sales by Category") {
            sales.byCategory.take(5).forEach { row ->
                LabelValueRow(row.categoryName, Formatting.money(row.total))
            }
        }

        SectionCard("Sales by Payment Method") {
            sales.byPaymentMethod.take(5).forEach { row ->
                LabelValueRow(row.method.replaceFirstChar { it.uppercase() }, Formatting.money(row.total))
            }
        }

        SectionCard("Best-Selling Products") {
            sales.byProduct.bestSelling.take(5).forEach { row ->
                LabelValueRow(row.name, "${Formatting.quantity(row.quantitySold)} sold")
            }
        }

        SectionCard("Most Profitable Products") {
            sales.byProduct.mostProfitable.take(5).forEach { row ->
                LabelValueRow(row.name, Formatting.money(row.margin))
            }
        }
    }
}

@Composable
private fun ProfitSection(profit: DashboardProfitResponse) {
    SectionCard("Profit & Margins") {
        LabelValueRow("Gross Sales", Formatting.money(profit.current.grossSales))
        LabelValueRow("Discounts", Formatting.money(profit.current.discounts))
        LabelValueRow("Cost of Goods Sold", Formatting.money(profit.current.cogs))
        LabelValueRow("Gross Profit", Formatting.money(profit.current.grossProfit))
        LabelValueRow("Gross Margin", profit.current.grossMarginPercent?.let { "${String.format(java.util.Locale.US, "%.1f", it)}%" } ?: "—")
        LabelValueRow("Expenses", Formatting.money(profit.current.expenses))
        LabelValueRow("Net Profit", Formatting.money(profit.current.netProfit))
        LabelValueRow("Net Margin", profit.current.netMarginPercent?.let { "${String.format(java.util.Locale.US, "%.1f", it)}%" } ?: "—")
        androidx.compose.foundation.layout.Spacer(Modifier.padding(top = 8.dp))
        Text(
            "vs previous period: revenue ${Formatting.percent(profit.changePercent.revenue)}, gross profit ${Formatting.percent(profit.changePercent.grossProfit)}, net profit ${Formatting.percent(profit.changePercent.netProfit)}",
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

@Composable
private fun ReceivablesSection(receivables: DashboardReceivablesResponse) {
    SectionCard("Receivables Aging") {
        Text("Outstanding: ${Formatting.money(receivables.totalOutstanding)}  •  Overdue: ${Formatting.money(receivables.overdueAmount)}", style = MaterialTheme.typography.bodySmall)
        Text("Recent collections (30d): ${Formatting.money(receivables.recentCollections)}", style = MaterialTheme.typography.bodySmall)
        if (receivables.collectionsTrend.isNotEmpty()) {
            SimpleBarChart(values = receivables.collectionsTrend.map { it.total.toFloat() })
        }
        androidx.compose.foundation.layout.Spacer(Modifier.padding(top = 8.dp))
        LabelValueRow("0-30 days", Formatting.money(receivables.agingBuckets.d0to30))
        LabelValueRow("31-60 days", Formatting.money(receivables.agingBuckets.d31to60))
        LabelValueRow("61-90 days", Formatting.money(receivables.agingBuckets.d61to90))
        LabelValueRow("90+ days", Formatting.money(receivables.agingBuckets.d90plus))
        if (receivables.topDebtors.isNotEmpty()) {
            androidx.compose.foundation.layout.Spacer(Modifier.padding(top = 8.dp))
            Text("Top Outstanding Balances", style = MaterialTheme.typography.labelMedium)
            receivables.topDebtors.take(5).forEach { debtor ->
                LabelValueRow(debtor.customerName, Formatting.money(debtor.amountDue))
            }
        }
    }
}

@Composable
private fun PurchasesSection(p: DashboardPurchasesResponse) {
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        SectionCard("Purchases") {
            if (p.trend.isNotEmpty()) SimpleBarChart(values = p.trend.map { it.total.toFloat() })
            Text("Received: ${Formatting.money(p.totals.total)}  •  Purchases: ${p.totals.count}", style = MaterialTheme.typography.bodySmall)
            Text("vs previous period: ${Formatting.percent(p.changePercent)}", style = MaterialTheme.typography.bodySmall)
            if (p.topSuppliers.isNotEmpty()) {
                androidx.compose.foundation.layout.Spacer(Modifier.padding(top = 8.dp))
                Text("Top Suppliers", style = MaterialTheme.typography.labelMedium)
                p.topSuppliers.take(5).forEach { LabelValueRow(it.supplierName, Formatting.money(it.total)) }
            }
        }
        SectionCard("Payables Aging") {
            Text("Outstanding: ${Formatting.money(p.payables.totalOutstanding)}  •  Overdue: ${Formatting.money(p.payables.overdueAmount)}", style = MaterialTheme.typography.bodySmall)
            androidx.compose.foundation.layout.Spacer(Modifier.padding(top = 8.dp))
            listOf("0-30", "31-60", "61-90", "90+").forEach { bucket ->
                LabelValueRow("$bucket days", Formatting.money(p.payables.agingBuckets[bucket] ?: 0.0))
            }
            if (p.payables.topCreditors.isNotEmpty()) {
                androidx.compose.foundation.layout.Spacer(Modifier.padding(top = 8.dp))
                Text("Top Amounts Owed", style = MaterialTheme.typography.labelMedium)
                p.payables.topCreditors.take(5).forEach { LabelValueRow(it.supplierName, Formatting.money(it.amountDue)) }
            }
        }
    }
}

@Composable
private fun CashSection(c: DashboardCashResponse) {
    SectionCard("Cash & Bank") {
        LabelValueRow("Cash (end of period)", Formatting.money(c.cash.closingBalance))
        LabelValueRow("Bank (end of period)", Formatting.money(c.bank.closingBalance))
        LabelValueRow("Total", Formatting.money(c.totals.closingBalance))
        androidx.compose.foundation.layout.Spacer(Modifier.padding(top = 8.dp))
        LabelValueRow("Money in", Formatting.money(c.totals.receipts))
        LabelValueRow("Money out", Formatting.money(c.totals.payments))
        LabelValueRow("Net change", Formatting.money(c.netChange))
        if (c.bySource.isNotEmpty()) {
            androidx.compose.foundation.layout.Spacer(Modifier.padding(top = 8.dp))
            Text("Where it moved", style = MaterialTheme.typography.labelMedium)
            c.bySource.take(5).forEach { LabelValueRow(it.source.lowercase().replace('_', ' ').replaceFirstChar { ch -> ch.uppercase() }, Formatting.money(it.net)) }
        }
    }
}

@Composable
private fun InventorySection(inventory: DashboardInventoryResponse) {
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        SectionCard("Inventory") {
            LabelValueRow("Inventory Value", Formatting.money(inventory.inventoryValue))
            LabelValueRow("Low Stock", inventory.lowStockCount.toString())
            LabelValueRow("Out of Stock", inventory.outOfStockCount.toString())
        }

        if (inventory.lowStockItems.isNotEmpty()) {
            SectionCard("Low Stock Items") {
                inventory.lowStockItems.take(5).forEach { item ->
                    LabelValueRow(item.name, "${Formatting.quantity(item.stockQuantity)} left")
                }
            }
        }

        if (inventory.slowMoving.items.isNotEmpty()) {
            SectionCard("Slow-Moving Stock") {
                Text("Capital tied up: ${Formatting.money(inventory.slowMoving.totalCapitalTiedUp)}", style = MaterialTheme.typography.bodySmall)
                inventory.slowMoving.items.take(5).forEach { item ->
                    LabelValueRow(item.name, Formatting.money(item.capitalTiedUp))
                }
            }
        }

        if (inventory.recentMovements.isNotEmpty()) {
            SectionCard("Recent Stock Movement") {
                inventory.recentMovements.take(5).forEach { movement ->
                    LabelValueRow(movement.productName, "${movement.type} ${Formatting.quantity(movement.quantity)}")
                }
            }
        }
    }
}

@Composable
private fun LabelValueRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}
