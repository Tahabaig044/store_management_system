package com.akvisionflow.owner.feature.analytics

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.akvisionflow.owner.core.filters.DashboardFilterRepository
import com.akvisionflow.owner.core.filters.DashboardFilters
import com.akvisionflow.owner.core.filters.DashboardRange
import com.akvisionflow.owner.core.network.ApiResult
import com.akvisionflow.owner.core.filters.withCompany
import com.akvisionflow.owner.core.network.dto.DashboardCashResponse
import com.akvisionflow.owner.core.network.dto.DashboardFiltersResponse
import com.akvisionflow.owner.core.network.dto.DashboardInventoryResponse
import com.akvisionflow.owner.core.network.dto.DashboardProfitResponse
import com.akvisionflow.owner.core.network.dto.DashboardPurchasesResponse
import com.akvisionflow.owner.core.network.dto.DashboardReceivablesResponse
import com.akvisionflow.owner.core.network.dto.DashboardSalesResponse
import com.akvisionflow.owner.feature.dashboard.DashboardRepository
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class AnalyticsUiState(
    val isLoading: Boolean = false,
    val sales: DashboardSalesResponse? = null,
    val profit: DashboardProfitResponse? = null,
    val receivables: DashboardReceivablesResponse? = null,
    val inventory: DashboardInventoryResponse? = null,
    // Phase 4.2
    val purchases: DashboardPurchasesResponse? = null,
    val cash: DashboardCashResponse? = null,
    val errorMessage: String? = null,
    val filters: DashboardFilters = DashboardFilters(),
    val filterOptions: DashboardFiltersResponse? = null,
)

/** Sales/profit trends, receivables aging, and inventory visibility - the Analytics tab. */
class AnalyticsViewModel(
    private val dashboardRepository: DashboardRepository,
    private val filterRepository: DashboardFilterRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow(AnalyticsUiState())
    val uiState: StateFlow<AnalyticsUiState> = _uiState.asStateFlow()

    init {
        viewModelScope.launch {
            filterRepository.filters.collectLatest { filters ->
                _uiState.update { it.copy(filters = filters) }
                load(filters)
            }
        }
        loadFilterOptions()
    }

    private fun loadFilterOptions() {
        viewModelScope.launch {
            when (val result = dashboardRepository.getFilterOptions()) {
                is ApiResult.Success -> _uiState.update { it.copy(filterOptions = result.data) }
                is ApiResult.Error -> Unit
            }
        }
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

    private suspend fun load(filters: DashboardFilters) {
        _uiState.update { it.copy(isLoading = true, errorMessage = null) }
        coroutineScope {
            val salesDeferred = async { dashboardRepository.getSales(filters) }
            val profitDeferred = async { dashboardRepository.getProfit(filters) }
            val receivablesDeferred = async { dashboardRepository.getReceivables(filters) }
            val inventoryDeferred = async { dashboardRepository.getInventory(filters) }
            val purchasesDeferred = async { dashboardRepository.getPurchases(filters) }
            val cashDeferred = async { dashboardRepository.getCash(filters) }

            val salesResult = salesDeferred.await()
            val profitResult = profitDeferred.await()
            val receivablesResult = receivablesDeferred.await()
            val inventoryResult = inventoryDeferred.await()
            val purchasesResult = purchasesDeferred.await()
            val cashResult = cashDeferred.await()

            var errorMessage: String? = null
            val sales = when (salesResult) {
                is ApiResult.Success -> salesResult.data
                is ApiResult.Error -> { errorMessage = salesResult.message; null }
            }
            val profit = when (profitResult) {
                is ApiResult.Success -> profitResult.data
                is ApiResult.Error -> { errorMessage = errorMessage ?: profitResult.message; null }
            }
            val receivables = when (receivablesResult) {
                is ApiResult.Success -> receivablesResult.data
                is ApiResult.Error -> { errorMessage = errorMessage ?: receivablesResult.message; null }
            }
            val inventory = when (inventoryResult) {
                is ApiResult.Success -> inventoryResult.data
                is ApiResult.Error -> { errorMessage = errorMessage ?: inventoryResult.message; null }
            }

            val purchases = when (purchasesResult) {
                is ApiResult.Success -> purchasesResult.data
                is ApiResult.Error -> { errorMessage = errorMessage ?: purchasesResult.message; null }
            }
            val cash = when (cashResult) {
                is ApiResult.Success -> cashResult.data
                is ApiResult.Error -> { errorMessage = errorMessage ?: cashResult.message; null }
            }

            _uiState.update {
                it.copy(
                    isLoading = false,
                    purchases = purchases ?: it.purchases,
                    cash = cash ?: it.cash,
                    sales = sales ?: it.sales,
                    profit = profit ?: it.profit,
                    receivables = receivables ?: it.receivables,
                    inventory = inventory ?: it.inventory,
                    errorMessage = errorMessage,
                )
            }
        }
    }

    fun retry() {
        viewModelScope.launch { load(uiState.value.filters) }
    }
}
