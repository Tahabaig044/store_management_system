package com.akvisionflow.owner.core.network

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
import retrofit2.http.GET
import retrofit2.http.QueryMap

/**
 * The Phase 2 executive-dashboard API. Every call is read-only (GET) and
 * takes the same shared filter set - see [com.akvisionflow.owner.core.filters.DashboardFilters].
 */
interface DashboardApiService {

    @GET("dashboard/summary")
    suspend fun summary(@QueryMap filters: Map<String, String>): Response<DashboardSummaryResponse>

    @GET("dashboard/sales")
    suspend fun sales(@QueryMap filters: Map<String, String>): Response<DashboardSalesResponse>

    @GET("dashboard/profit")
    suspend fun profit(@QueryMap filters: Map<String, String>): Response<DashboardProfitResponse>

    @GET("dashboard/expenses")
    suspend fun expenses(@QueryMap filters: Map<String, String>): Response<ExpensesSummaryDto>

    @GET("dashboard/receivables")
    suspend fun receivables(@QueryMap filters: Map<String, String>): Response<DashboardReceivablesResponse>

    @GET("dashboard/purchases")
    suspend fun purchases(@QueryMap filters: Map<String, String>): Response<DashboardPurchasesResponse>

    @GET("dashboard/cash")
    suspend fun cash(@QueryMap filters: Map<String, String>): Response<DashboardCashResponse>

    @GET("dashboard/inventory")
    suspend fun inventory(@QueryMap filters: Map<String, String>): Response<DashboardInventoryResponse>

    @GET("dashboard/filters")
    suspend fun filters(): Response<DashboardFiltersResponse>
}
