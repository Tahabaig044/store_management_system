package com.akvisionflow.owner.feature.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.akvisionflow.owner.core.data.DashboardSnapshot
import com.akvisionflow.owner.core.data.DashboardSnapshotStore
import com.akvisionflow.owner.core.data.InMemoryDashboardSnapshotStore
import com.akvisionflow.owner.core.filters.DashboardFilterRepository
import com.akvisionflow.owner.core.filters.DashboardFilters
import com.akvisionflow.owner.core.filters.DashboardRange
import com.akvisionflow.owner.core.filters.withCompany
import com.akvisionflow.owner.core.network.ApiErrorKind
import com.akvisionflow.owner.core.network.ApiResult
import com.akvisionflow.owner.core.network.dto.AlertDto
import com.akvisionflow.owner.core.network.dto.DashboardFiltersResponse
import com.akvisionflow.owner.core.network.dto.DashboardSummaryResponse
import com.akvisionflow.owner.feature.alerts.AlertsRepository
import com.akvisionflow.owner.feature.dashboard.DashboardRepository
import com.akvisionflow.owner.feature.profile.ProfileRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json

/** The important (critical + important) unread alerts, for the Home strip. */
data class ImportantAlerts(val unreadCount: Int = 0, val top: List<AlertDto> = emptyList())

data class HomeUiState(
    val isLoading: Boolean = false,
    val summary: DashboardSummaryResponse? = null,
    val errorMessage: String? = null,
    val filters: DashboardFilters = DashboardFilters(),
    val filterOptions: DashboardFiltersResponse? = null,
    val currencyCode: String? = null,
    /** Non-null when the figures on screen are saved ones (the server could not be reached): when they were saved. */
    val staleAsOf: Long? = null,
    val alerts: ImportantAlerts = ImportantAlerts(),
)

/** Executive overview - the Home tab. Reacts to filter changes made here or on the Analytics tab. */
class HomeViewModel(
    private val dashboardRepository: DashboardRepository,
    private val filterRepository: DashboardFilterRepository,
    private val profileRepository: ProfileRepository,
    private val snapshotStore: DashboardSnapshotStore = InMemoryDashboardSnapshotStore(),
    private val alertsRepository: AlertsRepository? = null,
    private val clock: () -> Long = System::currentTimeMillis,
) : ViewModel() {

    private val json = Json { ignoreUnknownKeys = true }
    private val _uiState = MutableStateFlow(HomeUiState())
    val uiState: StateFlow<HomeUiState> = _uiState.asStateFlow()

    init {
        viewModelScope.launch {
            filterRepository.filters.collectLatest { filters ->
                _uiState.update { it.copy(filters = filters) }
                loadSummary(filters)
            }
        }
        loadFilterOptions()
        loadCurrency()
        loadAlerts()
    }

    private fun loadCurrency() {
        profileRepository.cachedProfile()?.let { cached ->
            _uiState.update { it.copy(currencyCode = cached.tenant.currency) }
        }
        viewModelScope.launch {
            when (val result = profileRepository.getProfile()) {
                is ApiResult.Success -> _uiState.update { it.copy(currencyCode = result.data.tenant.currency) }
                is ApiResult.Error -> Unit
            }
        }
    }

    private fun loadFilterOptions() {
        viewModelScope.launch {
            when (val result = dashboardRepository.getFilterOptions()) {
                is ApiResult.Success -> _uiState.update { it.copy(filterOptions = result.data) }
                // A failed filter-options fetch only disables the filter
                // picker; the KPI summary itself doesn't depend on it, so
                // it's not surfaced as a blocking error.
                is ApiResult.Error -> Unit
            }
        }
    }

    private fun loadAlerts() {
        val repo = alertsRepository ?: return
        viewModelScope.launch {
            when (val result = repo.listAlerts(status = "unread", important = true)) {
                is ApiResult.Success -> _uiState.update { it.copy(alerts = ImportantAlerts(result.data.total, result.data.items.take(3))) }
                is ApiResult.Error -> Unit // the strip simply keeps what it had
            }
        }
    }

    private fun snapshotKey(filters: DashboardFilters) = filters.toQueryMap().toSortedMap().entries.joinToString("&") { "${it.key}=${it.value}" }

    private suspend fun loadSummary(filters: DashboardFilters) {
        _uiState.update { it.copy(isLoading = true, errorMessage = null) }
        when (val result = dashboardRepository.getSummary(filters)) {
            is ApiResult.Success -> {
                snapshotStore.save(snapshotKey(filters), DashboardSnapshot(json.encodeToString(DashboardSummaryResponse.serializer(), result.data), clock()))
                _uiState.update { it.copy(isLoading = false, summary = result.data, staleAsOf = null) }
            }
            is ApiResult.Error -> {
                // Offline or unreachable: show the last figures the server gave for THIS selection, marked as saved.
                // Anything else (permission, validation, an expired session) is a real answer and is never papered over.
                val saved = if (result.kind == ApiErrorKind.NETWORK || result.kind == ApiErrorKind.SERVER) savedSummary(filters) else null
                _uiState.update {
                    when {
                        saved != null -> it.copy(isLoading = false, summary = saved.first, staleAsOf = saved.second, errorMessage = result.message)
                        else -> it.copy(isLoading = false, summary = if (result.kind == ApiErrorKind.NETWORK || result.kind == ApiErrorKind.SERVER) it.summary else null, errorMessage = result.message)
                    }
                }
            }
        }
    }

    private fun savedSummary(filters: DashboardFilters): Pair<DashboardSummaryResponse, Long>? {
        val snap = snapshotStore.get(snapshotKey(filters)) ?: return null
        val parsed = runCatching { json.decodeFromString(DashboardSummaryResponse.serializer(), snap.json) }.getOrNull() ?: return null
        return parsed to snap.savedAt
    }

    fun retry() {
        viewModelScope.launch { loadSummary(uiState.value.filters) }
        loadAlerts()
    }

    fun setRange(range: DashboardRange, fromIso: String? = null, toIso: String? = null) {
        filterRepository.update { it.copy(range = range, fromIso = fromIso ?: it.fromIso, toIso = toIso ?: it.toIso) }
    }

    fun setCompany(id: String?, name: String?) {
        filterRepository.update { it.withCompany(id, name) }
    }

    fun setBranch(id: String?, name: String?) {
        filterRepository.update { it.copy(branchId = id, branchName = name) }
    }

    fun setCategory(id: String?, name: String?) {
        filterRepository.update { it.copy(categoryId = id, categoryName = name) }
    }

    fun setBusinessArea(area: String?) {
        filterRepository.update { it.copy(businessArea = area) }
    }
}
