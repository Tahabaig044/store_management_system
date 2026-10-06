package com.akvisionflow.owner.feature.aiadvisor

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.akvisionflow.owner.core.network.ApiResult
import com.akvisionflow.owner.core.network.dto.AiHomeResponse
import com.akvisionflow.owner.core.network.dto.AiInsightDto
import com.akvisionflow.owner.feature.alerts.AlertsRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class AiAdvisorUiState(
    val isLoading: Boolean = false,
    val home: AiHomeResponse? = null,
    val errorMessage: String? = null,
)

/** AI Advisor Home (Phase 4): latest daily advice, needs-attention preview, and trend. */
class AiAdvisorViewModel(private val repository: AiAdvisorRepository) : ViewModel() {

    private val _uiState = MutableStateFlow(AiAdvisorUiState())
    val uiState: StateFlow<AiAdvisorUiState> = _uiState.asStateFlow()

    init {
        load()
    }

    fun load() {
        _uiState.update { it.copy(isLoading = true, errorMessage = null) }
        viewModelScope.launch {
            when (val result = repository.getHome()) {
                is ApiResult.Success -> _uiState.update { it.copy(isLoading = false, home = result.data) }
                is ApiResult.Error -> _uiState.update { it.copy(isLoading = false, errorMessage = result.message) }
            }
        }
    }
}

data class AiBriefingUiState(
    val isLoading: Boolean = false,
    val briefing: AiInsightDto? = null,
    val errorMessage: String? = null,
)

/** The Daily Briefing screen. */
class AiBriefingViewModel(private val repository: AiAdvisorRepository) : ViewModel() {

    private val _uiState = MutableStateFlow(AiBriefingUiState())
    val uiState: StateFlow<AiBriefingUiState> = _uiState.asStateFlow()

    init {
        load()
    }

    fun load(forceRegenerate: Boolean = false) {
        _uiState.update { it.copy(isLoading = true, errorMessage = null) }
        viewModelScope.launch {
            when (val result = repository.getBriefing(forceRegenerate = forceRegenerate)) {
                is ApiResult.Success -> _uiState.update { it.copy(isLoading = false, briefing = result.data.item) }
                is ApiResult.Error -> _uiState.update { it.copy(isLoading = false, errorMessage = result.message) }
            }
        }
    }
}

data class AiNeedsAttentionUiState(
    val isLoading: Boolean = false,
    val items: List<AiInsightDto> = emptyList(),
    val errorMessage: String? = null,
)

/** The Needs Attention screen: the full prioritized list (Home shows only a preview). */
class AiNeedsAttentionViewModel(private val repository: AiAdvisorRepository) : ViewModel() {

    private val _uiState = MutableStateFlow(AiNeedsAttentionUiState())
    val uiState: StateFlow<AiNeedsAttentionUiState> = _uiState.asStateFlow()

    init {
        load()
    }

    fun load() {
        _uiState.update { it.copy(isLoading = true, errorMessage = null) }
        viewModelScope.launch {
            when (val result = repository.getNeedsAttention()) {
                is ApiResult.Success -> _uiState.update { it.copy(isLoading = false, items = result.data.items) }
                is ApiResult.Error -> _uiState.update { it.copy(isLoading = false, errorMessage = result.message) }
            }
        }
    }
}

data class AiHistoryUiState(
    val isLoading: Boolean = false,
    val items: List<AiInsightDto> = emptyList(),
    val typeFilter: String? = null,
    val errorMessage: String? = null,
)

/** AI History: previous daily briefs and insights for reference. */
class AiHistoryViewModel(private val repository: AiAdvisorRepository) : ViewModel() {

    private val _uiState = MutableStateFlow(AiHistoryUiState())
    val uiState: StateFlow<AiHistoryUiState> = _uiState.asStateFlow()

    init {
        load()
    }

    fun setTypeFilter(type: String?) {
        _uiState.update { it.copy(typeFilter = type) }
        load()
    }

    fun load() {
        _uiState.update { it.copy(isLoading = true, errorMessage = null) }
        viewModelScope.launch {
            when (val result = repository.getHistory(insightType = _uiState.value.typeFilter)) {
                is ApiResult.Success -> _uiState.update { it.copy(isLoading = false, items = result.data.items) }
                is ApiResult.Error -> _uiState.update { it.copy(isLoading = false, errorMessage = result.message) }
            }
        }
    }
}

data class AiInsightDetailUiState(
    val isLoading: Boolean = false,
    val insight: AiInsightDto? = null,
    val errorMessage: String? = null,
    val isActing: Boolean = false,
)

/**
 * Insight Detail. Read/dismiss reuse the Phase 3 [com.akvisionflow.owner.feature.alerts.AlertsRepository]
 * endpoints directly - AI insights are the same underlying AiInsight rows
 * Phase 3's Alert Center already exposes a read/dismiss action for.
 */
class AiInsightDetailViewModel(
    private val repository: AiAdvisorRepository,
    private val alertsRepository: AlertsRepository,
    private val insightId: String,
) : ViewModel() {

    private val _uiState = MutableStateFlow(AiInsightDetailUiState())
    val uiState: StateFlow<AiInsightDetailUiState> = _uiState.asStateFlow()

    init {
        load()
    }

    fun load() {
        _uiState.update { it.copy(isLoading = true, errorMessage = null) }
        viewModelScope.launch {
            when (val result = repository.getInsight(insightId)) {
                is ApiResult.Success -> _uiState.update { it.copy(isLoading = false, insight = result.data.item) }
                is ApiResult.Error -> _uiState.update { it.copy(isLoading = false, errorMessage = result.message) }
            }
        }
    }

    fun dismiss() {
        if (_uiState.value.isActing) return
        _uiState.update { it.copy(isActing = true) }
        viewModelScope.launch {
            when (val result = alertsRepository.dismiss(insightId)) {
                is ApiResult.Success -> _uiState.update {
                    it.copy(
                        isActing = false,
                        insight = it.insight?.copy(isDismissed = true, isRead = true, status = "DISMISSED"),
                    )
                }
                is ApiResult.Error -> _uiState.update { it.copy(isActing = false, errorMessage = result.message) }
            }
        }
    }
}
