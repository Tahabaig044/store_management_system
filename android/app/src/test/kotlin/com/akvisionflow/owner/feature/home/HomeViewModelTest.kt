package com.akvisionflow.owner.feature.home

import com.akvisionflow.owner.core.filters.DashboardFilterRepository
import com.akvisionflow.owner.core.filters.DashboardRange
import com.akvisionflow.owner.core.network.ApiResultMapper
import com.akvisionflow.owner.core.network.dto.DashboardSummaryResponse
import com.akvisionflow.owner.core.network.dto.ExpenseStatDto
import com.akvisionflow.owner.core.network.dto.ExpensesSummaryDto
import com.akvisionflow.owner.core.network.dto.InventorySummaryLiteDto
import com.akvisionflow.owner.core.network.dto.OrdersStatDto
import com.akvisionflow.owner.core.network.dto.OrdersSummaryDto
import com.akvisionflow.owner.core.network.dto.PeriodStatDto
import com.akvisionflow.owner.core.network.dto.ProfitSummaryDto
import com.akvisionflow.owner.core.network.dto.ReceivablesSummaryDto
import com.akvisionflow.owner.core.network.dto.SalesSummaryDto
import com.akvisionflow.owner.feature.dashboard.DashboardRepository
import com.akvisionflow.owner.feature.profile.ProfileRepository
import com.akvisionflow.owner.testutil.FakeDashboardApiService
import com.akvisionflow.owner.testutil.FakeMobileApiService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import retrofit2.Response

@OptIn(ExperimentalCoroutinesApi::class)
class HomeViewModelTest {

    private val dispatcher = StandardTestDispatcher()
    private val json = Json { ignoreUnknownKeys = true }

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun emptySummary() = DashboardSummaryResponse(
        sales = SalesSummaryDto(PeriodStatDto(0.0, 0), PeriodStatDto(0.0, 0), PeriodStatDto(0.0, 0), PeriodStatDto(0.0, 0)),
        profit = ProfitSummaryDto(0.0, 0.0),
        expenses = ExpensesSummaryDto(ExpenseStatDto(0.0), ExpenseStatDto(0.0)),
        receivables = ReceivablesSummaryDto(0.0, 0.0, 0.0),
        orders = OrdersSummaryDto(OrdersStatDto(0), OrdersStatDto(0)),
        inventory = InventorySummaryLiteDto(0.0, 0, 0),
    )

    @Test
    fun `loads the summary on init using the current filters`() = runTest {
        val dashboardApi = FakeDashboardApiService(summaryResponse = Response.success(emptySummary()))
        val filterRepository = DashboardFilterRepository()
        HomeViewModel(
            DashboardRepository(dashboardApi, ApiResultMapper(json) {}),
            filterRepository,
            ProfileRepository(FakeMobileApiService(), ApiResultMapper(json) {}),
        )

        dispatcher.scheduler.advanceUntilIdle()

        assertEquals(1, dashboardApi.summaryCallCount)
        assertEquals(mapOf("range" to "today"), dashboardApi.lastSummaryQuery)
    }

    @Test
    fun `changing the shared filter re-fetches the summary with the new query`() = runTest {
        val dashboardApi = FakeDashboardApiService(summaryResponse = Response.success(emptySummary()))
        val filterRepository = DashboardFilterRepository()
        val viewModel = HomeViewModel(
            DashboardRepository(dashboardApi, ApiResultMapper(json) {}),
            filterRepository,
            ProfileRepository(FakeMobileApiService(), ApiResultMapper(json) {}),
        )
        dispatcher.scheduler.advanceUntilIdle()

        viewModel.setRange(DashboardRange.MONTH)
        dispatcher.scheduler.advanceUntilIdle()

        assertEquals(2, dashboardApi.summaryCallCount)
        assertEquals(mapOf("range" to "month"), dashboardApi.lastSummaryQuery)
    }

    @Test
    fun `setBranch updates the shared filter and re-fetches`() = runTest {
        val dashboardApi = FakeDashboardApiService(summaryResponse = Response.success(emptySummary()))
        val filterRepository = DashboardFilterRepository()
        val viewModel = HomeViewModel(
            DashboardRepository(dashboardApi, ApiResultMapper(json) {}),
            filterRepository,
            ProfileRepository(FakeMobileApiService(), ApiResultMapper(json) {}),
        )
        dispatcher.scheduler.advanceUntilIdle()

        viewModel.setBranch("b1", "Main Branch")
        dispatcher.scheduler.advanceUntilIdle()

        assertEquals(mapOf("range" to "today", "branchId" to "b1"), dashboardApi.lastSummaryQuery)
        assertEquals("Main Branch", filterRepository.filters.value.branchName)
    }
}
