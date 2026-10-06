package com.akvisionflow.owner.core.network.dto

import kotlinx.serialization.Serializable

// Mirror the exact JSON shapes returned by
// backend/src/modules/mobile/dashboard.routes.js (Phase 2). As with the
// Phase 1 mobile DTOs, these are flat and endpoint-specific rather than one
// generic envelope, matching what the backend actually sends.

@Serializable
data class PeriodStatDto(
    val total: Double,
    val count: Int,
    val changePercent: Double? = null,
)

@Serializable
data class SalesSummaryDto(
    val today: PeriodStatDto,
    val yesterday: PeriodStatDto,
    val week: PeriodStatDto,
    val month: PeriodStatDto,
)

@Serializable
data class ProfitSummaryDto(
    val grossProfit: Double,
    val netProfit: Double,
    val grossMarginPercent: Double? = null,
    val netMarginPercent: Double? = null,
)

@Serializable
data class ExpenseStatDto(
    val total: Double,
    val changePercent: Double? = null,
)

@Serializable
data class ExpenseCategoryBreakdownDto(
    val categoryId: String? = null,
    val categoryName: String,
    val total: Double,
)

@Serializable
data class ExpensesSummaryDto(
    val today: ExpenseStatDto,
    val month: ExpenseStatDto,
    val byCategory: List<ExpenseCategoryBreakdownDto> = emptyList(),
)

@Serializable
data class ReceivablesSummaryDto(
    val totalOutstanding: Double,
    val overdueAmount: Double,
    val recentCollections: Double,
)

@Serializable
data class OrdersStatDto(
    val transactionCount: Int,
    val averageTransactionValue: Double? = null,
)

@Serializable
data class OrdersSummaryDto(
    val today: OrdersStatDto,
    val month: OrdersStatDto,
)

@Serializable
data class InventorySummaryLiteDto(
    val inventoryValue: Double,
    val lowStockCount: Int,
    val outOfStockCount: Int,
    // "ALL_BRANCHES": stock is held for the whole business, so this block ignores the branch/company filter.
    val scope: String? = null,
)

@Serializable
data class PurchaseStatDto(
    val total: Double,
    val count: Int,
)

@Serializable
data class PurchasesSummaryDto(
    val today: PurchaseStatDto,
    val month: PurchaseStatDto,
)

@Serializable
data class PayablesSummaryDto(
    val totalOutstanding: Double,
    val overdueAmount: Double,
)

/** Cash and bank balances from the ledger, as of now. */
@Serializable
data class CashSummaryDto(
    val cash: Double,
    val bank: Double,
    val total: Double,
)

@Serializable
data class DashboardSummaryResponse(
    val sales: SalesSummaryDto,
    val profit: ProfitSummaryDto,
    val expenses: ExpensesSummaryDto,
    val receivables: ReceivablesSummaryDto,
    val orders: OrdersSummaryDto,
    val inventory: InventorySummaryLiteDto,
    // Phase 4.2 - absent when talking to an older server.
    val purchases: PurchasesSummaryDto? = null,
    val payables: PayablesSummaryDto? = null,
    val cash: CashSummaryDto? = null,
)

// ---------------------------------------------------------------------------
// /dashboard/sales
// ---------------------------------------------------------------------------

@Serializable
data class DateRangeDto(
    val from: String,
    val to: String,
)

@Serializable
data class SalesTotalsDto(
    val revenue: Double,
    val discount: Double,
    val saleCount: Int,
    val cogs: Double,
    val grossProfit: Double,
    val grossMarginPercent: Double? = null,
)

@Serializable
data class SalesComparisonDto(
    val previous: SalesTotalsDto,
    val changePercent: Double? = null,
    val comparedPeriod: DateRangeDto,
)

@Serializable
data class SalesTrendPointDto(
    val date: String,
    val total: Double,
    val count: Int,
)

@Serializable
data class BranchBreakdownDto(
    val branchId: String? = null,
    val branchName: String,
    val total: Double,
    val count: Int,
)

@Serializable
data class CategoryBreakdownDto(
    val categoryId: String? = null,
    val categoryName: String,
    val total: Double,
    val quantity: Double,
)

@Serializable
data class PaymentMethodBreakdownDto(
    val method: String,
    val total: Double,
    val count: Int,
)

@Serializable
data class ProductMarginRowDto(
    val productId: String,
    val name: String,
    val revenue: Double,
    val cost: Double,
    val quantitySold: Double,
    val margin: Double,
    val marginPercent: Double? = null,
)

@Serializable
data class ProductMarginsDto(
    val bestSelling: List<ProductMarginRowDto> = emptyList(),
    val mostProfitable: List<ProductMarginRowDto> = emptyList(),
    val lowMargin: List<ProductMarginRowDto> = emptyList(),
)

@Serializable
data class DashboardSalesTotalsDto(
    val revenue: Double,
    val discount: Double,
    val saleCount: Int,
    val averageTransactionValue: Double? = null,
)

@Serializable
data class DashboardSalesResponse(
    val range: DateRangeDto,
    val totals: DashboardSalesTotalsDto,
    val comparison: SalesComparisonDto,
    val trend: List<SalesTrendPointDto> = emptyList(),
    val byBranch: List<BranchBreakdownDto> = emptyList(),
    val byCategory: List<CategoryBreakdownDto> = emptyList(),
    val byPaymentMethod: List<PaymentMethodBreakdownDto> = emptyList(),
    val byProduct: ProductMarginsDto,
)

// ---------------------------------------------------------------------------
// /dashboard/profit
// ---------------------------------------------------------------------------

@Serializable
data class ProfitPeriodDto(
    val grossSales: Double,
    val discounts: Double,
    val cogs: Double,
    val grossProfit: Double,
    val grossMarginPercent: Double? = null,
    val expenses: Double,
    val netProfit: Double,
    val netMarginPercent: Double? = null,
)

@Serializable
data class ProfitChangePercentDto(
    val revenue: Double? = null,
    val grossProfit: Double? = null,
    val netProfit: Double? = null,
)

@Serializable
data class DashboardProfitResponse(
    val range: DateRangeDto,
    val comparedPeriod: DateRangeDto,
    val current: ProfitPeriodDto,
    val previous: ProfitPeriodDto,
    val changePercent: ProfitChangePercentDto,
)

// ---------------------------------------------------------------------------
// /dashboard/receivables
// ---------------------------------------------------------------------------

@Serializable
data class AgingBucketsDto(
    @kotlinx.serialization.SerialName("0-30") val d0to30: Double = 0.0,
    @kotlinx.serialization.SerialName("31-60") val d31to60: Double = 0.0,
    @kotlinx.serialization.SerialName("61-90") val d61to90: Double = 0.0,
    @kotlinx.serialization.SerialName("90+") val d90plus: Double = 0.0,
)

@Serializable
data class CollectionTrendPointDto(
    val date: String,
    val total: Double,
)

@Serializable
data class DebtorDto(
    val customerId: String? = null,
    val customerName: String,
    val amountDue: Double,
    val daysOverdue: Int,
)

@Serializable
data class DashboardReceivablesResponse(
    val totalOutstanding: Double,
    val overdueAmount: Double,
    val recentCollections: Double,
    val collectionsTrend: List<CollectionTrendPointDto> = emptyList(),
    val agingBuckets: AgingBucketsDto,
    val topDebtors: List<DebtorDto> = emptyList(),
)

// ---------------------------------------------------------------------------
// /dashboard/inventory
// ---------------------------------------------------------------------------

@Serializable
data class LowStockItemDto(
    val productId: String,
    val name: String,
    val stockQuantity: Double,
    val lowStockThreshold: Double,
    val dailyVelocity: Double,
    val daysOfStockRemaining: Double? = null,
    val isLowStock: Boolean,
    val suggestedReorderQuantity: Int? = null,
)

@Serializable
data class SlowMovingItemDto(
    val productId: String,
    val name: String,
    val stockQuantity: Double,
    val capitalTiedUp: Double,
)

@Serializable
data class SlowMovingStockDto(
    val windowDays: Int,
    val items: List<SlowMovingItemDto> = emptyList(),
    val totalCapitalTiedUp: Double,
)

@Serializable
data class StockMovementDto(
    val productName: String,
    val type: String,
    val quantity: Double,
    val balanceAfter: Double,
    val createdAt: String,
)

@Serializable
data class DashboardInventoryResponse(
    val inventoryValue: Double,
    val lowStockCount: Int,
    val outOfStockCount: Int,
    val lowStockItems: List<LowStockItemDto> = emptyList(),
    val slowMoving: SlowMovingStockDto,
    val recentMovements: List<StockMovementDto> = emptyList(),
)

// ---------------------------------------------------------------------------
// /dashboard/filters
// ---------------------------------------------------------------------------

@Serializable
data class FilterOptionDto(
    val id: String,
    val name: String,
    // Branches carry the company they belong to, so choosing a company can narrow the branch list.
    val companyId: String? = null,
)

@Serializable
data class DashboardFiltersResponse(
    val companies: List<FilterOptionDto> = emptyList(),
    val branches: List<FilterOptionDto> = emptyList(),
    val categories: List<FilterOptionDto> = emptyList(),
    val businessAreas: List<String> = emptyList(),
)

// ---------------------------------------------------------------------------
// /dashboard/purchases (Phase 4.2)
// ---------------------------------------------------------------------------

@Serializable
data class SupplierTotalDto(
    val supplierId: String? = null,
    val supplierName: String,
    val total: Double,
    val count: Int,
)

@Serializable
data class CreditorDto(
    val supplierId: String? = null,
    val supplierName: String,
    val amountDue: Double,
    val daysOverdue: Int,
)

@Serializable
data class PayablesDetailDto(
    val totalOutstanding: Double,
    val overdueAmount: Double,
    val agingBuckets: Map<String, Double> = emptyMap(),
    val topCreditors: List<CreditorDto> = emptyList(),
)

@Serializable
data class DashboardPurchasesResponse(
    val range: DateRangeDto,
    val totals: PurchaseStatDto,
    val previous: PurchaseStatDto,
    val changePercent: Double? = null,
    val trend: List<SalesTrendPointDto> = emptyList(),
    val topSuppliers: List<SupplierTotalDto> = emptyList(),
    val payables: PayablesDetailDto,
)

// ---------------------------------------------------------------------------
// /dashboard/cash (Phase 4.2)
// ---------------------------------------------------------------------------

@Serializable
data class MoneyAccountDto(
    val openingBalance: Double,
    val receipts: Double,
    val payments: Double,
    val closingBalance: Double,
)

@Serializable
data class CashTotalsDto(
    val openingBalance: Double,
    val receipts: Double,
    val payments: Double,
    val closingBalance: Double,
)

@Serializable
data class CashSourceDto(
    val source: String,
    val net: Double,
)

@Serializable
data class DashboardCashResponse(
    val range: DateRangeDto,
    val cash: MoneyAccountDto,
    val bank: MoneyAccountDto,
    val totals: CashTotalsDto,
    val netChange: Double,
    val bySource: List<CashSourceDto> = emptyList(),
)
