package com.akvisionflow.owner.feature.alerts

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.akvisionflow.owner.core.network.ApiResult
import com.akvisionflow.owner.core.network.dto.AlertDto
import com.akvisionflow.owner.core.network.dto.NotificationPreferencesDto
import com.akvisionflow.owner.core.network.dto.UpdateNotificationPreferencesRequest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class AlertsUiState(
    val isLoading: Boolean = false,
    val alerts: List<AlertDto> = emptyList(),
    val statusFilter: String = "all",
    val errorMessage: String? = null,
    val preferences: NotificationPreferencesDto? = null,
    val showPreferences: Boolean = false,
)

/** The Alert Center - Phase 3's read-only alert list with a dismiss/read exception (see backend comment). */
class AlertsViewModel(private val alertsRepository: AlertsRepository) : ViewModel() {

    private val _uiState = MutableStateFlow(AlertsUiState())
    val uiState: StateFlow<AlertsUiState> = _uiState.asStateFlow()

    init {
        load()
    }

    fun load() {
        _uiState.update { it.copy(isLoading = true, errorMessage = null) }
        viewModelScope.launch {
            when (val result = alertsRepository.listAlerts(status = _uiState.value.statusFilter)) {
                is ApiResult.Success -> _uiState.update { it.copy(isLoading = false, alerts = result.data.items) }
                is ApiResult.Error -> _uiState.update { it.copy(isLoading = false, errorMessage = result.message) }
            }
        }
    }

    fun setStatusFilter(status: String) {
        _uiState.update { it.copy(statusFilter = status) }
        load()
    }

    fun markRead(alertId: String) {
        viewModelScope.launch {
            when (val result = alertsRepository.markRead(alertId)) {
                is ApiResult.Success -> _uiState.update { state ->
                    state.copy(alerts = state.alerts.map { if (it.id == alertId) result.data.item else it })
                }
                is ApiResult.Error -> _uiState.update { it.copy(errorMessage = result.message) }
            }
        }
    }

    fun dismiss(alertId: String) {
        viewModelScope.launch {
            when (val result = alertsRepository.dismiss(alertId)) {
                is ApiResult.Success -> _uiState.update { state ->
                    state.copy(alerts = state.alerts.filter { it.id != alertId })
                }
                is ApiResult.Error -> _uiState.update { it.copy(errorMessage = result.message) }
            }
        }
    }

    fun openPreferences() {
        _uiState.update { it.copy(showPreferences = true) }
        viewModelScope.launch {
            when (val result = alertsRepository.getPreferences()) {
                is ApiResult.Success -> _uiState.update { it.copy(preferences = result.data.item) }
                is ApiResult.Error -> _uiState.update { it.copy(errorMessage = result.message) }
            }
        }
    }

    fun closePreferences() {
        _uiState.update { it.copy(showPreferences = false) }
    }

    fun updatePreferences(update: UpdateNotificationPreferencesRequest) {
        viewModelScope.launch {
            when (val result = alertsRepository.updatePreferences(update)) {
                is ApiResult.Success -> _uiState.update { it.copy(preferences = result.data.item) }
                is ApiResult.Error -> _uiState.update { it.copy(errorMessage = result.message) }
            }
        }
    }
}
