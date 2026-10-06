package com.akvisionflow.owner.core.filters

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class DashboardFiltersTest {

    @Test
    fun `default filters send only the range`() {
        val filters = DashboardFilters()
        assertEquals(mapOf("range" to "today"), filters.toQueryMap())
    }

    @Test
    fun `custom range includes from and to`() {
        val filters = DashboardFilters(range = DashboardRange.CUSTOM, fromIso = "2026-01-01", toIso = "2026-01-31")
        val map = filters.toQueryMap()
        assertEquals("custom", map["range"])
        assertEquals("2026-01-01", map["from"])
        assertEquals("2026-01-31", map["to"])
    }

    @Test
    fun `non-custom range omits from and to even if set`() {
        val filters = DashboardFilters(range = DashboardRange.WEEK, fromIso = "2026-01-01", toIso = "2026-01-31")
        val map = filters.toQueryMap()
        assertFalse(map.containsKey("from"))
        assertFalse(map.containsKey("to"))
    }

    @Test
    fun `branch, category, and business area are included when set`() {
        val filters = DashboardFilters(branchId = "b1", categoryId = "c1", businessArea = "FRAME")
        val map = filters.toQueryMap()
        assertEquals("b1", map["branchId"])
        assertEquals("c1", map["categoryId"])
        assertEquals("FRAME", map["productType"])
    }

    @Test
    fun `branchLabel and categoryLabel fall back to All when unset`() {
        val filters = DashboardFilters()
        assertEquals("All Branches", filters.branchLabel)
        assertEquals("All Categories", filters.categoryLabel)
    }

    @Test
    fun `branchLabel and categoryLabel reflect the selected name`() {
        val filters = DashboardFilters(branchId = "b1", branchName = "Main Branch", categoryId = "c1", categoryName = "Frames")
        assertEquals("Main Branch", filters.branchLabel)
        assertEquals("Frames", filters.categoryLabel)
    }
}
