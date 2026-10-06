package com.akvisionflow.owner.testutil

import com.akvisionflow.owner.core.network.DashboardApiService
import com.akvisionflow.owner.core.network.dto.DashboardCashResponse
import com.akvisionflow.owner.core.network.dto.DashboardFiltersResponse
import com.akvisionflow.owner.core.network.dto.DashboardInventoryResponse
import com.akvisionflow.owner.core.network.dto.DashboardProfitResponse
import com.akvisionflow.owner.core.network.dto.DashboardPurchasesResponse
import com.akvisionflow.owner.core.network.dto.DashboardReceivablesResponse
import com.akvisionflow.owner.core.network.dto.DashboardSalesResponse
import com.akvisionflow.owner.core.network.dto.DashboardSummaryResponse
import com.akvisionflow.owner.core.network.dto.ExpensesSummaryDto
import retrofit2.Response

/** In-memory fake used by repository/viewmodel tests - no real HTTP involved. */
class FakeDashboardApiService(
    private var summaryResponse: Response<DashboardSummaryResponse>? = null,
    private var salesResponse: Response<DashboardSalesResponse>? = null,
    private var profitResponse: Response<DashboardProfitResponse>? = null,
    private var expensesResponse: Response<ExpensesSummaryDto>? = null,
    private var receivablesResponse: Response<DashboardReceivablesResponse>? = null,
    private var inventoryResponse: Response<DashboardInventoryResponse>? = null,
    private var filtersResponse: Response<DashboardFiltersResponse>? = null,
    private var purchasesResponse: Response<DashboardPurchasesResponse>? = null,
    private var cashResponse: Response<DashboardCashResponse>? = null,
) : DashboardApiService {

    /** When set, summary() throws it (e.g. an IOException = no network) instead of answering. */
    var summaryFailure: Throwable? = null
    fun setSummaryResponse(r: Response<DashboardSummaryResponse>) { summaryResponse = r }

    var lastSummaryQuery: Map<String, String>? = null
        private set
    var summaryCallCount = 0
        private set

    override suspend fun summary(filters: Map<String, String>): Response<DashboardSummaryResponse> {
        summaryCallCount++
        lastSummaryQuery = filters
        summaryFailure?.let { throw it }
        return summaryResponse ?: error("summary() not stubbed")
    }

    override suspend fun sales(filters: Map<String, String>): Response<DashboardSalesResponse> =
        salesResponse ?: error("sales() not stubbed")

    override suspend fun profit(filters: Map<String, String>): Response<DashboardProfitResponse> =
        profitResponse ?: error("profit() not stubbed")

    override suspend fun expenses(filters: Map<String, String>): Response<ExpensesSummaryDto> =
        expensesResponse ?: error("expenses() not stubbed")

    override suspend fun receivables(filters: Map<String, String>): Response<DashboardReceivablesResponse> =
        receivablesResponse ?: error("receivables() not stubbed")

    override suspend fun purchases(filters: Map<String, String>): Response<DashboardPurchasesResponse> =
        purchasesResponse ?: error("purchases() not stubbed")

    override suspend fun cash(filters: Map<String, String>): Response<DashboardCashResponse> =
        cashResponse ?: error("cash() not stubbed")

    override suspend fun inventory(filters: Map<String, String>): Response<DashboardInventoryResponse> =
        inventoryResponse ?: error("inventory() not stubbed")

    override suspend fun filters(): Response<DashboardFiltersResponse> =
        filtersResponse ?: error("filters() not stubbed")
}
