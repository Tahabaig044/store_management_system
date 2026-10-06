package com.akvisionflow.owner.feature.dashboard

import com.akvisionflow.owner.core.network.dto.DashboardCashResponse
import com.akvisionflow.owner.core.network.dto.DashboardFiltersResponse
import com.akvisionflow.owner.core.network.dto.DashboardPurchasesResponse
import com.akvisionflow.owner.core.network.dto.DashboardSummaryResponse
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Contract tests: these JSON files are REAL responses saved from the backend (tests/mobileDashboard42.test.js with
 * DUMP_CONTRACT_DIR set), parsed here by the app's own DTOs and JSON settings. If the server's response and the
 * app's model ever disagree (a renamed or missing field), these fail - not the user's screen.
 */
class DashboardContractTest {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    private fun fixture(name: String): String =
        checkNotNull(javaClass.getResourceAsStream("/contract/$name")) { "missing fixture $name" }.bufferedReader().readText()

    @Test
    fun `the real summary response parses, including purchases, payables, cash and the stock scope`() {
        val s = json.decodeFromString(DashboardSummaryResponse.serializer(), fixture("dashboard-summary.json"))
        assertEquals(450.0, s.purchases!!.month.total, 0.001)
        assertEquals(2, s.purchases!!.month.count)
        assertEquals(300.0, s.payables!!.totalOutstanding, 0.001)
        assertNotNull(s.cash)
        assertEquals(s.cash!!.cash + s.cash!!.bank, s.cash!!.total, 0.001)
        assertEquals("ALL_BRANCHES", s.inventory.scope)
        assertEquals(600.0, s.expenses.month.total, 0.001) // the reversed expense is not in it
    }

    @Test
    fun `the real purchases response parses with its trend, suppliers and payables aging`() {
        val p = json.decodeFromString(DashboardPurchasesResponse.serializer(), fixture("dashboard-purchases.json"))
        assertEquals(450.0, p.totals.total, 0.001)
        assertEquals("Supplier One", p.topSuppliers.first().supplierName)
        assertEquals(300.0, p.payables.agingBuckets["0-30"]!!, 0.001)
        assertTrue(p.trend.isNotEmpty())
    }

    @Test
    fun `the real cash response parses with cash, bank, totals and sources`() {
        val c = json.decodeFromString(DashboardCashResponse.serializer(), fixture("dashboard-cash.json"))
        assertEquals(c.cash.closingBalance + c.bank.closingBalance, c.totals.closingBalance, 0.001)
        assertTrue(c.bySource.isNotEmpty())
    }

    @Test
    fun `the real filter options carry companies, and branches know their company`() {
        val f = json.decodeFromString(DashboardFiltersResponse.serializer(), fixture("dashboard-filters.json"))
        assertEquals(3, f.companies.size) // the two created + the shop's default company
        assertTrue(f.branches.all { it.companyId != null })
    }
}
