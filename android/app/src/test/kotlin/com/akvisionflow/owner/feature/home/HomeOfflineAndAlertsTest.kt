package com.akvisionflow.owner.feature.home

import com.akvisionflow.owner.core.data.InMemoryDashboardSnapshotStore
import com.akvisionflow.owner.core.filters.DashboardFilterRepository
import com.akvisionflow.owner.core.filters.withCompany
import com.akvisionflow.owner.core.network.ApiResultMapper
import com.akvisionflow.owner.core.network.dto.AlertDto
import com.akvisionflow.owner.core.network.dto.AlertListResponse
import com.akvisionflow.owner.core.network.dto.CashSummaryDto
import com.akvisionflow.owner.core.network.dto.DashboardSummaryResponse
import com.akvisionflow.owner.core.network.dto.ExpenseStatDto
import com.akvisionflow.owner.core.network.dto.ExpensesSummaryDto
import com.akvisionflow.owner.core.network.dto.InventorySummaryLiteDto
import com.akvisionflow.owner.core.network.dto.OrdersStatDto
import com.akvisionflow.owner.core.network.dto.OrdersSummaryDto
import com.akvisionflow.owner.core.network.dto.PayablesSummaryDto
import com.akvisionflow.owner.core.network.dto.PeriodStatDto
import com.akvisionflow.owner.core.network.dto.ProfitSummaryDto
import com.akvisionflow.owner.core.network.dto.PurchaseStatDto
import com.akvisionflow.owner.core.network.dto.PurchasesSummaryDto
import com.akvisionflow.owner.core.network.dto.ReceivablesSummaryDto
import com.akvisionflow.owner.core.network.dto.SalesSummaryDto
import com.akvisionflow.owner.feature.alerts.AlertsRepository
import com.akvisionflow.owner.feature.dashboard.DashboardRepository
import com.akvisionflow.owner.feature.profile.ProfileRepository
import com.akvisionflow.owner.core.data.DeviceIdProvider
import com.akvisionflow.owner.testutil.FakeAlertsApiService
import com.akvisionflow.owner.testutil.FakeDashboardApiService
import com.akvisionflow.owner.testutil.FakeMobileApiService
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import retrofit2.Response

/** Phase 4.2: the Home tab keeps working offline (saved figures, clearly marked), shows important alerts, and follows the company filter. */
@OptIn(ExperimentalCoroutinesApi::class)
class HomeOfflineAndAlertsTest {

    private val dispatcher = StandardTestDispatcher()
    private val json = Json { ignoreUnknownKeys = true }
    private val mapper = ApiResultMapper(json) {}

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    private fun summary(salesToday: Double = 100.0) = DashboardSummaryResponse(
        sales = SalesSummaryDto(PeriodStatDto(salesToday, 1), PeriodStatDto(0.0, 0), PeriodStatDto(0.0, 0), PeriodStatDto(0.0, 0)),
        profit = ProfitSummaryDto(0.0, 0.0),
        expenses = ExpensesSummaryDto(ExpenseStatDto(0.0), ExpenseStatDto(0.0)),
        receivables = ReceivablesSummaryDto(0.0, 0.0, 0.0),
        orders = OrdersSummaryDto(OrdersStatDto(0), OrdersStatDto(0)),
        inventory = InventorySummaryLiteDto(0.0, 0, 0, "ALL_BRANCHES"),
        purchases = PurchasesSummaryDto(PurchaseStatDto(10.0, 1), PurchaseStatDto(20.0, 2)),
        payables = PayablesSummaryDto(5.0, 1.0),
        cash = CashSummaryDto(30.0, 20.0, 50.0),
    )

    private fun alert(id: String, priority: String) = AlertDto(id, "INVENTORY", priority, "Alert $id", "s", null, null, false, false, "2026-09-25T00:00:00Z", null, null, "analytics")

    private fun vm(
        api: FakeDashboardApiService,
        store: InMemoryDashboardSnapshotStore = InMemoryDashboardSnapshotStore(),
        filters: DashboardFilterRepository = DashboardFilterRepository(),
        alerts: AlertsRepository? = null,
        now: Long = 1_000L,
    ) = HomeViewModel(
        DashboardRepository(api, mapper),
        filters,
        ProfileRepository(FakeMobileApiService(), mapper),
        store,
        alerts,
    ) { now }

    @Test
    fun `figures loaded online are saved, and shown - dated and marked - when the network is gone`() = runTest {
        val api = FakeDashboardApiService(summaryResponse = Response.success(summary(123.0)))
        val store = InMemoryDashboardSnapshotStore()
        val model = vm(api, store, now = 5_000L)
        dispatcher.scheduler.advanceUntilIdle()
        assertNull(model.uiState.value.staleAsOf)

        api.summaryFailure = IOException("no network")
        model.retry()
        dispatcher.scheduler.advanceUntilIdle()

        val state = model.uiState.value
        assertEquals(123.0, state.summary!!.sales.today.total, 0.001)
        assertEquals(5_000L, state.staleAsOf)
        assertNotNull(state.errorMessage) // and it says why they are old
    }

    @Test
    fun `a fresh start with no network shows the last saved figures for the same selection`() = runTest {
        val store = InMemoryDashboardSnapshotStore()
        val first = FakeDashboardApiService(summaryResponse = Response.success(summary(77.0)))
        vm(first, store, now = 9_000L)
        dispatcher.scheduler.advanceUntilIdle()

        val offline = FakeDashboardApiService(summaryResponse = Response.success(summary())).also { it.summaryFailure = IOException("no network") }
        val model = vm(offline, store)
        dispatcher.scheduler.advanceUntilIdle()

        assertEquals(77.0, model.uiState.value.summary!!.sales.today.total, 0.001)
        assertEquals(9_000L, model.uiState.value.staleAsOf)
    }

    @Test
    fun `saved figures are per selection - another filter never shows them`() = runTest {
        val store = InMemoryDashboardSnapshotStore()
        vm(FakeDashboardApiService(summaryResponse = Response.success(summary(77.0))), store)
        dispatcher.scheduler.advanceUntilIdle()

        val filters = DashboardFilterRepository().also { it.update { f -> f.withCompany("c1", "Alpha") } }
        val offline = FakeDashboardApiService(summaryResponse = Response.success(summary())).also { it.summaryFailure = IOException("no network") }
        val model = vm(offline, store, filters)
        dispatcher.scheduler.advanceUntilIdle()

        assertNull(model.uiState.value.summary) // nothing was ever saved for company c1
        assertNull(model.uiState.value.staleAsOf)
    }

    @Test
    fun `a real refusal (no permission) is shown as the refusal, never hidden behind saved figures`() = runTest {
        val store = InMemoryDashboardSnapshotStore()
        val api = FakeDashboardApiService(summaryResponse = Response.success(summary(77.0)))
        val model = vm(api, store)
        dispatcher.scheduler.advanceUntilIdle()

        api.setSummaryResponse(Response.error(403, """{"error":"You do not have permission to view report"}""".toResponseBody("application/json".toMediaType())))
        model.retry()
        dispatcher.scheduler.advanceUntilIdle()

        assertNull(model.uiState.value.summary)
        assertNull(model.uiState.value.staleAsOf)
        assertEquals("You do not have permission to view report", model.uiState.value.errorMessage)
    }

    @Test
    fun `the important alerts strip shows the unread count and the top three, asking the server for important ones only`() = runTest {
        val alertsApi = FakeAlertsApiService(
            listResponse = Response.success(AlertListResponse(listOf(alert("1", "CRITICAL"), alert("2", "IMPORTANT"), alert("3", "IMPORTANT"), alert("4", "IMPORTANT")), 4, 1, 20)),
        )
        val alerts = AlertsRepository(alertsApi, mapper, object : DeviceIdProvider { override fun getOrCreateId() = "d" })
        val model = vm(FakeDashboardApiService(summaryResponse = Response.success(summary())), alerts = alerts)
        dispatcher.scheduler.advanceUntilIdle()

        assertEquals(4, model.uiState.value.alerts.unreadCount)
        assertEquals(listOf("1", "2", "3"), model.uiState.value.alerts.top.map { it.id })
        assertEquals("true", alertsApi.lastListQuery!!["important"])
        assertEquals("unread", alertsApi.lastListQuery!!["status"])
    }

    @Test
    fun `choosing a company sends it to the server and drops a branch that may belong to another company`() = runTest {
        val api = FakeDashboardApiService(summaryResponse = Response.success(summary()))
        val filters = DashboardFilterRepository()
        val model = vm(api, filters = filters)
        dispatcher.scheduler.advanceUntilIdle()
        model.setBranch("b9", "Other")
        dispatcher.scheduler.advanceUntilIdle()

        model.setCompany("c1", "Alpha Co")
        dispatcher.scheduler.advanceUntilIdle()

        assertEquals(mapOf("range" to "today", "companyId" to "c1"), api.lastSummaryQuery)
        assertNull(filters.filters.value.branchId)
    }
}
