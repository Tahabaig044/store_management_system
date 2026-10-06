package com.akvisionflow.owner.core.filters

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Single source of truth for the current dashboard filter selection, shared across screens. */
class DashboardFilterRepository {
    private val _filters = MutableStateFlow(DashboardFilters())
    val filters: StateFlow<DashboardFilters> = _filters.asStateFlow()

    fun update(transform: (DashboardFilters) -> DashboardFilters) {
        _filters.value = transform(_filters.value)
    }

    fun reset() {
        _filters.value = DashboardFilters()
    }
}
