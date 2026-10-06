package com.akvisionflow.owner.feature.manage

import com.akvisionflow.owner.core.data.SessionContext
import com.akvisionflow.owner.core.network.ApiErrorKind
import com.akvisionflow.owner.core.network.ApiResult
import com.akvisionflow.owner.core.network.ApiResultMapper
import com.akvisionflow.owner.core.network.NetworkModule
import com.akvisionflow.owner.testutil.FakeManageApiService
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Phase 4.3: every test here reads REAL saved server responses through the app's own DTOs (FakeManageApiService). */
@OptIn(ExperimentalCoroutinesApi::class)
class ManageTest {

    private val dispatcher = StandardTestDispatcher()
    private val mapper = ApiResultMapper(Json { ignoreUnknownKeys = true }) {}
    private val api = FakeManageApiService()
    private val repo = ManageRepository(api, mapper) { "PKR" }

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    private fun ctx(vararg perms: String) = SessionContext("u", "N", "e@x.test", "MANAGER", "Shop", "PKR", perms.toSet())

    // ---- permission-aware areas -------------------------------------------------------------------------
    @Test
    fun `a session sees only the areas its permissions allow, approvals last`() {
        assertEquals(listOf(ManageKind.CUSTOMERS, ManageKind.STOCK_TRANSFERS), visibleKinds(ctx("CUSTOMER:VIEW", "STOCK_TRANSFER:VIEW", "REPORT:VIEW")))
        assertTrue(visibleKinds(ctx("REPORT:VIEW")).isEmpty())
        assertTrue(visibleKinds(null).isEmpty())
    }

    @Test
    fun `an approval is offered only for a pending document AND when the session holds the approve permission`() = runTest {
        val pending = (repo.detail(ManageKind.PURCHASE_REQUESTS, "x") as ApiResult.Success).data
        assertTrue(pending.awaitingDecision)
        assertTrue(canDecide(ctx("PURCHASE_REQUEST:VIEW", "PURCHASE_REQUEST:APPROVE"), pending))
        assertFalse(canDecide(ctx("PURCHASE_REQUEST:VIEW"), pending)) // can view, cannot decide
        assertFalse(canDecide(ctx("PURCHASE_REQUEST:APPROVE"), pending.copy(awaitingDecision = false))) // already decided
        val sale = (repo.detail(ManageKind.SALES, "x") as ApiResult.Success).data
        assertFalse(canDecide(ctx("SALE:VIEW", "PURCHASE_REQUEST:APPROVE"), sale)) // a sale is never approvable
    }

    // ---- lists and details from real responses ----------------------------------------------------------
    @Test
    fun `lists show what the server sent, formatted, and search goes to the server as a search term`() = runTest {
        val customers = (repo.list(ManageKind.CUSTOMERS, "Ann") as ApiResult.Success).data
        assertEquals("Ann Optical", customers.rows.first().title)
        assertEquals("0300111", customers.rows.first().subtitle)
        assertEquals("Ann", api.listQueries.last().second["search"])

        val products = (repo.list(ManageKind.PRODUCTS) as ApiResult.Success).data.rows.first()
        assertEquals("Ray Frame X", products.title)
        assertEquals("RF-X · 5551234", products.subtitle)
        assertTrue(products.trailing!!.endsWith("in stock"))

        val sale = (repo.list(ManageKind.SALES) as ApiResult.Success).data.rows.first()
        assertTrue(sale.title.startsWith("INV-"))
        assertTrue(sale.trailing!!.startsWith("PKR "))
        assertEquals("Ann Optical", sale.subtitle!!.substringAfter(" · "))
    }

    @Test
    fun `approval queues open on what is waiting for a decision and have no search box`() = runTest {
        repo.list(ManageKind.PURCHASE_ORDERS, "ignored")
        assertEquals("PENDING_APPROVAL", api.listQueries.last().second["status"])
        assertNull(api.listQueries.last().second["search"])
        assertFalse(ManageKind.PURCHASE_ORDERS.searchable)
    }

    @Test
    fun `a customer detail carries balance and history, and a sale shows its items and what is left to pay`() = runTest {
        val c = (repo.detail(ManageKind.CUSTOMERS, "x") as ApiResult.Success).data
        assertEquals("Ann Optical", c.title)
        assertNotNull(c.fields.firstOrNull { it.label == "Balance due" })
        assertEquals("Recent sales", c.sections.first().title)

        val s = (repo.detail(ManageKind.SALES, "x") as ApiResult.Success).data
        assertEquals("Items", s.sections.first().title)
        assertEquals("PKR 80.00", s.fields.first { it.label == "Balance" }.value) // 180 total, 100 paid
        assertEquals("Ray Frame X", s.sections.first().lines.first().title)
    }

    @Test
    fun `supplier ledger and product stock detail`() = runTest {
        val sup = (repo.detail(ManageKind.SUPPLIERS, "x") as ApiResult.Success).data
        assertNotNull(sup.fields.firstOrNull { it.label == "Balance owed" })
        val p = (repo.detail(ManageKind.PRODUCTS, "x") as ApiResult.Success).data
        assertTrue(p.fields.any { it.label == "In stock" })
        assertTrue(p.fields.any { it.label == "Selling price" && it.value.startsWith("PKR") })
    }

    // ---- approvals -------------------------------------------------------------------------------------
    @Test
    fun `approving and rejecting call the right existing endpoint for each document type`() = runTest {
        assertTrue(repo.decide(ManageKind.PURCHASE_REQUESTS, "a", true) is ApiResult.Success)
        assertTrue(repo.decide(ManageKind.PURCHASE_ORDERS, "b", false, "Too dear") is ApiResult.Success)
        assertTrue(repo.decide(ManageKind.STOCK_TRANSFERS, "c", true) is ApiResult.Success)
        assertEquals(listOf("purchase-requests/approve:a", "purchase-orders/reject:b:Too dear", "stock-transfers/approve:c"), api.decisions)
    }

    @Test
    fun `a rejection without a reason never leaves the phone, and a non-approvable kind is refused outright`() = runTest {
        val r = repo.decide(ManageKind.PURCHASE_REQUESTS, "a", false, "  ") as ApiResult.Error
        assertEquals(ApiErrorKind.VALIDATION, r.kind)
        val s = repo.decide(ManageKind.SALES, "a", true) as ApiResult.Error
        assertEquals(ApiErrorKind.FORBIDDEN, s.kind)
        assertTrue(api.decisions.isEmpty())
    }

    @Test
    fun `somebody else decided first so the server conflict comes back as such, not as a second decision`() = runTest {
        api.decisionStatus = 409
        val r = repo.decide(ManageKind.PURCHASE_REQUESTS, "a", true) as ApiResult.Error
        assertEquals("CONFLICT", r.code)
    }

    // ---- view models -----------------------------------------------------------------------------------
    @Test
    fun `typing searches once after a pause, not on every key`() = runTest {
        val vm = ManageListViewModel(ManageKind.CUSTOMERS, repo, searchDelayMs = 300)
        dispatcher.scheduler.advanceUntilIdle()
        val before = api.listQueries.size
        vm.onSearchChanged("A"); dispatcher.scheduler.advanceTimeBy(100)
        vm.onSearchChanged("An"); dispatcher.scheduler.advanceTimeBy(100)
        vm.onSearchChanged("Ann"); dispatcher.scheduler.advanceUntilIdle()
        assertEquals(before + 1, api.listQueries.size)
        assertEquals("Ann", api.listQueries.last().second["search"])
        assertEquals(1, vm.state.value.rows.size)
    }

    @Test
    fun `an unreachable server keeps the list on screen with the reason and a way to retry`() = runTest {
        val vm = ManageListViewModel(ManageKind.SALES, repo)
        dispatcher.scheduler.advanceUntilIdle()
        assertTrue(vm.state.value.rows.isNotEmpty())
        api.failWith = IOException("offline")
        vm.retry()
        dispatcher.scheduler.advanceUntilIdle()
        assertTrue(vm.state.value.rows.isNotEmpty()) // still there
        assertNotNull(vm.state.value.errorMessage)
        api.failWith = null
        vm.retry()
        dispatcher.scheduler.advanceUntilIdle()
        assertNull(vm.state.value.errorMessage)
    }

    @Test
    fun `more pages load once each and never duplicate a row`() = runTest {
        api.pagedTotal = 3
        api.pageSizeOverride = 1
        val vm = ManageListViewModel(ManageKind.CUSTOMERS, repo)
        dispatcher.scheduler.advanceUntilIdle()
        assertTrue(vm.state.value.hasMore)
        vm.loadMore(); vm.loadMore() // a second call while the first runs is ignored
        dispatcher.scheduler.advanceUntilIdle()
        assertEquals(listOf(1, 2), api.listQueries.map { it.second["page"]!!.toInt() })
        assertEquals(1, vm.state.value.rows.size) // the fixture repeats the same row: de-duplicated by id
    }

    @Test
    fun `deciding a double tap is one decision, and the document is reloaded to the server state`() = runTest {
        val vm = ManageDetailViewModel(ManageKind.PURCHASE_REQUESTS, "pr-1", repo)
        dispatcher.scheduler.advanceUntilIdle()
        vm.approve(); vm.approve()
        dispatcher.scheduler.advanceUntilIdle()
        assertEquals(listOf("purchase-requests/approve:pr-1"), api.decisions)
        assertEquals(DecisionOutcome.Done(true), vm.state.value.outcome)
        assertNotNull(vm.state.value.detail)
    }

    @Test
    fun `a lost race shows already decided and reloads, a refusal shows the reason, nothing is retried by itself`() = runTest {
        val vm = ManageDetailViewModel(ManageKind.STOCK_TRANSFERS, "t-1", repo)
        dispatcher.scheduler.advanceUntilIdle()

        api.decisionStatus = 409
        vm.approve(); dispatcher.scheduler.advanceUntilIdle()
        assertEquals(DecisionOutcome.AlreadyDecided, vm.state.value.outcome)

        api.decisionStatus = 403
        api.decisionBody = """{"error":"You do not have permission to approve stock transfer","code":"FORBIDDEN"}"""
        vm.approve(); dispatcher.scheduler.advanceUntilIdle()
        assertEquals(DecisionOutcome.Refused("You do not have permission to approve stock transfer"), vm.state.value.outcome)
        assertEquals(2, api.decisions.size)
    }

    // ---- what is written to disk ---------------------------------------------------------------------
    @Test
    fun `only the mobile dashboard and profile responses may be cached on disk - never customers, sales or stock`() {
        assertFalse(NetworkModule.isManagementPath("/api/mobile/v1/dashboard/summary"))
        assertFalse(NetworkModule.isManagementPath("/api/mobile/v1/profile"))
        for (p in listOf("/api/customers", "/api/customers/abc/history", "/api/sales", "/api/procurement/purchase-requests", "/api/stock-transfers/x")) {
            assertTrue(p, NetworkModule.isManagementPath(p))
        }
    }
}
