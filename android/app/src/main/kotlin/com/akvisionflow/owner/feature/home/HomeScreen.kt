package com.akvisionflow.owner.feature.home

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.akvisionflow.owner.core.filters.DashboardRange
import com.akvisionflow.owner.core.network.dto.DashboardSummaryResponse
import com.akvisionflow.owner.core.ui.components.DashboardFilterControls
import com.akvisionflow.owner.core.ui.components.KpiCard
import com.akvisionflow.owner.core.util.Formatting
import java.text.DateFormat
import java.util.Date

const val STALE_BANNER_TAG = "stale_banner"
const val ALERTS_STRIP_TAG = "important_alerts"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    viewModel: HomeViewModel,
    onOpenAnalytics: () -> Unit,
    modifier: Modifier = Modifier,
    onOpenAlerts: () -> Unit = {},
    /** Increases each time the connection returns after being lost: the figures refresh by themselves. */
    reconnectCount: Int = 0,
) {
    val uiState by viewModel.uiState.collectAsState()

    LaunchedEffect(reconnectCount) {
        if (reconnectCount > 0) viewModel.retry()
    }

    Scaffold(
        modifier = modifier,
        topBar = { TopAppBar(title = { Text("BizOS") }) },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            DashboardFilterControls(
                filters = uiState.filters,
                filterOptions = uiState.filterOptions,
                onRangeSelected = viewModel::setRange,
                onCustomRangeSelected = { from, to -> viewModel.setRange(DashboardRange.CUSTOM, from, to) },
                onBranchSelected = viewModel::setBranch,
                onCategorySelected = viewModel::setCategory,
                onBusinessAreaSelected = viewModel::setBusinessArea,
                onCompanySelected = viewModel::setCompany,
            )

            when {
                uiState.isLoading && uiState.summary == null -> {
                    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator()
                    }
                }
                uiState.errorMessage != null && uiState.summary == null -> {
                    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(uiState.errorMessage ?: "", color = MaterialTheme.colorScheme.error)
                        Button(onClick = viewModel::retry, modifier = Modifier.padding(top = 12.dp)) { Text("Retry") }
                    }
                }
                uiState.summary != null -> {
                    val summary = uiState.summary!!
                    val currency = uiState.currencyCode
                    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        uiState.staleAsOf?.let { savedAt -> item { StaleBanner(savedAt, viewModel::retry) } }
                        if (uiState.alerts.unreadCount > 0) item { ImportantAlertsStrip(uiState.alerts, onOpenAlerts) }
                        summarySections(summary, currency, onOpenAnalytics)
                    }
                }
            }
        }
    }
}

/** "Showing saved figures" - the server could not be reached, so the last figures it gave are shown, dated. */
@Composable
private fun StaleBanner(savedAt: Long, onRetry: () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer),
        modifier = Modifier.fillMaxWidth().testTag(STALE_BANNER_TAG),
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Text(
                "Showing saved figures from ${DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(savedAt))}. They may be out of date.",
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.weight(1f),
            )
            Button(onClick = onRetry, modifier = Modifier.padding(start = 8.dp)) { Text("Refresh") }
        }
    }
}

@Composable
private fun ImportantAlertsStrip(alerts: ImportantAlerts, onOpenAlerts: () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
        modifier = Modifier.fillMaxWidth().clickable(onClick = onOpenAlerts).testTag(ALERTS_STRIP_TAG),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                if (alerts.unreadCount == 1) "1 important alert needs your attention" else "${alerts.unreadCount} important alerts need your attention",
                style = MaterialTheme.typography.titleSmall,
            )
            alerts.top.forEach { a ->
                Text("${if (a.priority == "CRITICAL") "Critical" else "Important"}: ${a.title}", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.summarySections(summary: DashboardSummaryResponse, currency: String?, onOpenAnalytics: () -> Unit) {
    item { Text("Sales", style = MaterialTheme.typography.titleMedium) }
    item {
        KpiRow(
            Kpi("Today", Formatting.money(summary.sales.today.total, currency), summary.sales.today.changePercent, onOpenAnalytics),
            Kpi("Yesterday", Formatting.money(summary.sales.yesterday.total, currency), summary.sales.yesterday.changePercent, onOpenAnalytics),
        )
    }
    item {
        KpiRow(
            Kpi("This Week", Formatting.money(summary.sales.week.total, currency), summary.sales.week.changePercent, onOpenAnalytics),
            Kpi("This Month", Formatting.money(summary.sales.month.total, currency), summary.sales.month.changePercent, onOpenAnalytics),
        )
    }

    item { Text("Profit (This Month)", style = MaterialTheme.typography.titleMedium) }
    item {
        KpiRow(
            Kpi("Gross Profit", Formatting.money(summary.profit.grossProfit, currency), onClick = onOpenAnalytics),
            Kpi("Net Profit", Formatting.money(summary.profit.netProfit, currency), onClick = onOpenAnalytics),
        )
    }

    summary.cash?.let { cash ->
        item { Text("Cash & Bank", style = MaterialTheme.typography.titleMedium) }
        item {
            KpiRow(
                Kpi("Cash", Formatting.money(cash.cash, currency), onClick = onOpenAnalytics),
                Kpi("Bank", Formatting.money(cash.bank, currency), onClick = onOpenAnalytics),
            )
        }
        item { KpiRow(Kpi("Total", Formatting.money(cash.total, currency), onClick = onOpenAnalytics)) }
    }

    item { Text("Receivables", style = MaterialTheme.typography.titleMedium) }
    item {
        KpiRow(
            Kpi("Outstanding", Formatting.money(summary.receivables.totalOutstanding, currency), onClick = onOpenAnalytics),
            Kpi("Overdue (30+ days)", Formatting.money(summary.receivables.overdueAmount, currency), onClick = onOpenAnalytics),
        )
    }

    summary.payables?.let { payables ->
        item { Text("Payables", style = MaterialTheme.typography.titleMedium) }
        item {
            KpiRow(
                Kpi("Outstanding", Formatting.money(payables.totalOutstanding, currency), onClick = onOpenAnalytics),
                Kpi("Overdue (30+ days)", Formatting.money(payables.overdueAmount, currency), onClick = onOpenAnalytics),
            )
        }
    }

    summary.purchases?.let { purchases ->
        item { Text("Purchases", style = MaterialTheme.typography.titleMedium) }
        item {
            KpiRow(
                Kpi("Today (${purchases.today.count})", Formatting.money(purchases.today.total, currency), onClick = onOpenAnalytics),
                Kpi("This Month (${purchases.month.count})", Formatting.money(purchases.month.total, currency), onClick = onOpenAnalytics),
            )
        }
    }

    item { Text("Expenses", style = MaterialTheme.typography.titleMedium) }
    item {
        KpiRow(
            Kpi("Today", Formatting.money(summary.expenses.today.total, currency), summary.expenses.today.changePercent),
            Kpi("This Month", Formatting.money(summary.expenses.month.total, currency), summary.expenses.month.changePercent),
        )
    }

    item { Text(if (summary.inventory.scope == "ALL_BRANCHES") "Stock (all branches)" else "Stock", style = MaterialTheme.typography.titleMedium) }
    item {
        KpiRow(
            Kpi("Inventory Value", Formatting.money(summary.inventory.inventoryValue, currency), onClick = onOpenAnalytics),
            Kpi("Low / Out of Stock", "${summary.inventory.lowStockCount} / ${summary.inventory.outOfStockCount}", onClick = onOpenAnalytics),
        )
    }

    item { Text("Orders", style = MaterialTheme.typography.titleMedium) }
    item {
        KpiRow(
            Kpi("Transactions Today", summary.orders.today.transactionCount.toString()),
            Kpi("Avg. Sale Today", summary.orders.today.averageTransactionValue?.let { Formatting.money(it, currency) } ?: "—"),
        )
    }
}

private data class Kpi(val label: String, val value: String, val changePercent: Double? = null, val onClick: (() -> Unit)? = null)

@Composable
private fun KpiRow(vararg kpis: Kpi) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        kpis.forEach { k ->
            KpiCard(label = k.label, value = k.value, changePercent = k.changePercent, onClick = k.onClick, modifier = Modifier.weight(1f))
        }
        if (kpis.size == 1) Box(Modifier.weight(1f))
    }
}
