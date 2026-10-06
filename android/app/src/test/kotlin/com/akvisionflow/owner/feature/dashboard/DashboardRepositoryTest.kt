package com.akvisionflow.owner.feature.dashboard

import com.akvisionflow.owner.core.filters.DashboardFilters
import com.akvisionflow.owner.core.filters.DashboardRange
import com.akvisionflow.owner.core.network.ApiResult
import com.akvisionflow.owner.core.network.ApiResultMapper
import com.akvisionflow.owner.core.network.dto.DashboardFiltersResponse
import com.akvisionflow.owner.core.network.dto.ExpensesSummaryDto
import com.akvisionflow.owner.core.network.dto.ExpenseStatDto
import com.akvisionflow.owner.testutil.FakeDashboardApiService
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Test
import retrofit2.Response

class DashboardRepositoryTest {

    private val json = Json { ignoreUnknownKeys = true }
    private val mapper = ApiResultMapper(json) {}

    @Test
    fun `getSummary forwards the filters query map to the API`() = runTest {
        val api = FakeDashboardApiService(
            summaryResponse = Response.success(
                com.akvisionflow.owner.core.network.dto.DashboardSummaryResponse(
                    sales = com.akvisionflow.owner.core.network.dto.SalesSummaryDto(
                        today = com.akvisionflow.owner.core.network.dto.PeriodStatDto(0.0, 0),
                        yesterday = com.akvisionflow.owner.core.network.dto.PeriodStatDto(0.0, 0),
                        week = com.akvisionflow.owner.core.network.dto.PeriodStatDto(0.0, 0),
                        month = com.akvisionflow.owner.core.network.dto.PeriodStatDto(0.0, 0),
                    ),
                    profit = com.akvisionflow.owner.core.network.dto.ProfitSummaryDto(0.0, 0.0),
                    expenses = ExpensesSummaryDto(ExpenseStatDto(0.0), ExpenseStatDto(0.0)),
                    receivables = com.akvisionflow.owner.core.network.dto.ReceivablesSummaryDto(0.0, 0.0, 0.0),
                    orders = com.akvisionflow.owner.core.network.dto.OrdersSummaryDto(
                        com.akvisionflow.owner.core.network.dto.OrdersStatDto(0),
                        com.akvisionflow.owner.core.network.dto.OrdersStatDto(0),
                    ),
                    inventory = com.akvisionflow.owner.core.network.dto.InventorySummaryLiteDto(0.0, 0, 0),
                ),
            ),
        )
        val repository = DashboardRepository(api, mapper)
        val filters = DashboardFilters(range = DashboardRange.MONTH, branchId = "b1", branchName = "Main")

        repository.getSummary(filters)

        assertEquals(mapOf("range" to "month", "branchId" to "b1"), api.lastSummaryQuery)
        assertEquals(1, api.summaryCallCount)
    }

    @Test
    fun `maps a 401 to an UNAUTHORIZED ApiResult`() = runTest {
        val api = FakeDashboardApiService(
            filtersResponse = Response.error(
                401,
                """{"error":"Invalid or expired token"}""".toResponseBody("application/json".toMediaType()),
            ),
        )
        val repository = DashboardRepository(api, mapper)

        val result = repository.getFilterOptions()

        val error = result as ApiResult.Error
        assertEquals("Invalid or expired token", error.message)
    }

    @Test
    fun `successful filter options fetch is unwrapped`() = runTest {
        val response = DashboardFiltersResponse(branches = emptyList(), categories = emptyList(), businessAreas = listOf("GENERAL"))
        val api = FakeDashboardApiService(filtersResponse = Response.success(response))
        val repository = DashboardRepository(api, mapper)

        val result = repository.getFilterOptions()

        assertEquals(ApiResult.Success(response), result)
    }
}
