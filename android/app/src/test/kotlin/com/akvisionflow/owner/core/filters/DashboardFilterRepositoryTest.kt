package com.akvisionflow.owner.core.filters

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DashboardFilterRepositoryTest {

    @Test
    fun `starts with default filters`() {
        val repo = DashboardFilterRepository()
        assertEquals(DashboardFilters(), repo.filters.value)
    }

    @Test
    fun `update applies a transform and is observable via filters`() {
        val repo = DashboardFilterRepository()
        repo.update { it.copy(range = DashboardRange.MONTH, branchId = "b1", branchName = "Main") }

        assertEquals(DashboardRange.MONTH, repo.filters.value.range)
        assertEquals("b1", repo.filters.value.branchId)
        assertEquals("Main", repo.filters.value.branchName)
    }

    @Test
    fun `reset clears back to defaults`() {
        val repo = DashboardFilterRepository()
        repo.update { it.copy(range = DashboardRange.WEEK, branchId = "b1") }
        repo.reset()

        assertEquals(DashboardRange.TODAY, repo.filters.value.range)
        assertNull(repo.filters.value.branchId)
    }
}
