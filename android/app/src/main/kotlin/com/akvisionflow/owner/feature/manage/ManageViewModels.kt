package com.akvisionflow.owner.feature.manage

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.akvisionflow.owner.core.network.ApiErrorKind
import com.akvisionflow.owner.core.network.ApiResult
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class ListUiState(
    val rows: List<Row> = emptyList(),
    val total: Int = 0,
    val search: String = "",
    val isLoading: Boolean = false,
    val isLoadingMore: Boolean = false,
    val errorMessage: String? = null,
    val hasMore: Boolean = false,
    /** True after the first answer, so an empty list reads "nothing found" rather than "not loaded yet". */
    val loaded: Boolean = false,
)

/** A searchable, pageable list of one management area. Typing searches after a short pause, never on every key. */
class ManageListViewModel(
    private val kind: ManageKind,
    private val repository: ManageRepository,
    private val searchDelayMs: Long = 350,
) : ViewModel() {

    private val _state = MutableStateFlow(ListUiState())
    val state: StateFlow<ListUiState> = _state.asStateFlow()
    private var page = 1
    private var searchJob: Job? = null
    private var loadJob: Job? = null

    init {
        reload()
    }

    fun onSearchChanged(text: String) {
        _state.update { it.copy(search = text) }
        searchJob?.cancel()
        searchJob = viewModelScope.launch {
            delay(searchDelayMs)
            reload()
        }
    }

    fun retry() = reload()

    private fun reload() {
        loadJob?.cancel()
        page = 1
        _state.update { it.copy(isLoading = true, errorMessage = null) }
        val term = _state.value.search
        loadJob = viewModelScope.launch {
            when (val r = repository.list(kind, term, 1)) {
                is ApiResult.Success -> _state.update { it.copy(rows = r.data.rows, total = r.data.total, hasMore = r.data.hasMore, isLoading = false, loaded = true) }
                // The list already on screen stays on screen; the message says why it could not be refreshed.
                is ApiResult.Error -> _state.update { it.copy(isLoading = false, errorMessage = r.message) }
            }
        }
    }

    fun loadMore() {
        val s = _state.value
        if (s.isLoading || s.isLoadingMore || !s.hasMore) return
        _state.update { it.copy(isLoadingMore = true) }
        val term = s.search
        viewModelScope.launch {
            when (val r = repository.list(kind, term, page + 1)) {
                is ApiResult.Success -> {
                    page += 1
                    _state.update { it.copy(rows = it.rows + r.data.rows.filter { row -> it.rows.none { old -> old.id == row.id } }, total = r.data.total, hasMore = r.data.hasMore, isLoadingMore = false) }
                }
                is ApiResult.Error -> _state.update { it.copy(isLoadingMore = false, errorMessage = r.message) }
            }
        }
    }
}

/** What happened to the last approval attempt, in words for the screen. */
sealed class DecisionOutcome {
    data class Done(val approved: Boolean) : DecisionOutcome()
    /** Somebody else decided it first (or it is no longer pending). Nothing was changed by this attempt. */
    data object AlreadyDecided : DecisionOutcome()
    data class Refused(val message: String) : DecisionOutcome()
}

data class DetailUiState(
    val isLoading: Boolean = false,
    val detail: Detail? = null,
    val errorMessage: String? = null,
    val isDeciding: Boolean = false,
    val outcome: DecisionOutcome? = null,
)

class ManageDetailViewModel(
    private val kind: ManageKind,
    private val id: String,
    private val repository: ManageRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(DetailUiState())
    val state: StateFlow<DetailUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun load() {
        _state.update { it.copy(isLoading = true, errorMessage = null) }
        viewModelScope.launch {
            when (val r = repository.detail(kind, id)) {
                is ApiResult.Success -> _state.update { it.copy(isLoading = false, detail = r.data) }
                is ApiResult.Error -> _state.update { it.copy(isLoading = false, errorMessage = r.message) }
            }
        }
    }

    fun approve() = decide(true, null)
    fun reject(reason: String) = decide(false, reason)
    fun dismissOutcome() = _state.update { it.copy(outcome = null) }

    private fun decide(approve: Boolean, reason: String?) {
        if (_state.value.isDeciding) return // a double tap is one decision
        _state.update { it.copy(isDeciding = true, outcome = null) }
        viewModelScope.launch {
            val outcome = when (val r = repository.decide(kind, id, approve, reason)) {
                is ApiResult.Success -> DecisionOutcome.Done(approve)
                is ApiResult.Error -> if (r.code == "CONFLICT") DecisionOutcome.AlreadyDecided else DecisionOutcome.Refused(r.message)
            }
            _state.update { it.copy(isDeciding = false, outcome = outcome) }
            // Whatever the answer, show the document as the server now has it.
            load()
        }
    }
}
