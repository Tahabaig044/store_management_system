package com.akvisionflow.owner.feature.dashboard

import com.akvisionflow.owner.core.filters.DashboardFilters
import com.akvisionflow.owner.core.network.ApiResult
import com.akvisionflow.owner.core.network.ApiResultMapper
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

/**
 * Thin pass-through to the mobile dashboard endpoints - all business math
 * already happened on the backend (see
 * backend/src/modules/mobile/dashboardService.js); this layer only fetches
 * and maps transport/error outcomes.
 */
class DashboardRepository(
    private val api: DashboardApiService,
    private val resultMapper: ApiResultMapper,
) {
    suspend fun getSummary(filters: DashboardFilters): ApiResult<DashboardSummaryResponse> =
        resultMapper.execute { api.summary(filters.toQueryMap()) }

    suspend fun getSales(filters: DashboardFilters): ApiResult<DashboardSalesResponse> =
        resultMapper.execute { api.sales(filters.toQueryMap()) }

    suspend fun getProfit(filters: DashboardFilters): ApiResult<DashboardProfitResponse> =
        resultMapper.execute { api.profit(filters.toQueryMap()) }

    suspend fun getExpenses(filters: DashboardFilters): ApiResult<ExpensesSummaryDto> =
        resultMapper.execute { api.expenses(filters.toQueryMap()) }

    suspend fun getReceivables(filters: DashboardFilters): ApiResult<DashboardReceivablesResponse> =
        resultMapper.execute { api.receivables(filters.toQueryMap()) }

    suspend fun getPurchases(filters: DashboardFilters): ApiResult<DashboardPurchasesResponse> =
        resultMapper.execute { api.purchases(filters.toQueryMap()) }

    suspend fun getCash(filters: DashboardFilters): ApiResult<DashboardCashResponse> =
        resultMapper.execute { api.cash(filters.toQueryMap()) }

    suspend fun getInventory(filters: DashboardFilters): ApiResult<DashboardInventoryResponse> =
        resultMapper.execute { api.inventory(filters.toQueryMap()) }

    suspend fun getFilterOptions(): ApiResult<DashboardFiltersResponse> =
        resultMapper.execute { api.filters() }
}
