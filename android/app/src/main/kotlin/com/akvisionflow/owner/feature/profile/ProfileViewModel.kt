package com.akvisionflow.owner.feature.profile

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.akvisionflow.owner.core.network.ApiResult
import com.akvisionflow.owner.core.network.dto.ProfileResponse
import com.akvisionflow.owner.feature.alerts.AlertsRepository
import com.akvisionflow.owner.feature.auth.AuthRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class ProfileUiState(
    val isLoading: Boolean = false,
    val profile: ProfileResponse? = null,
    val errorMessage: String? = null,
    val isLoggingOut: Boolean = false,
)

class ProfileViewModel(
    private val profileRepository: ProfileRepository,
    private val authRepository: AuthRepository,
    private val alertsRepository: AlertsRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow(ProfileUiState())
    val uiState: StateFlow<ProfileUiState> = _uiState.asStateFlow()

    init {
        load()
    }

    fun load(forceRefresh: Boolean = false) {
        _uiState.value = _uiState.value.copy(isLoading = true, errorMessage = null)
        viewModelScope.launch {
            when (val result = profileRepository.getProfile(forceRefresh)) {
                is ApiResult.Success -> {
                    _uiState.value = _uiState.value.copy(isLoading = false, profile = result.data)
                }
                is ApiResult.Error -> {
                    _uiState.value = _uiState.value.copy(isLoading = false, errorMessage = result.message)
                }
            }
        }
    }

    fun logout() {
        if (_uiState.value.isLoggingOut) return
        _uiState.value = _uiState.value.copy(isLoggingOut = true)
        viewModelScope.launch {
            // Best-effort: unregister before the session token is discarded,
            // so this device stops receiving push alerts once signed out.
            alertsRepository.unregisterThisDevice()
            authRepository.logout()
            profileRepository.clearCache()
            // SessionRepository.state flips to LoggedOut as a side effect of
            // authRepository.logout(); the nav host reacts to that and
            // returns to the login screen, so no navigation call is needed
            // here.
        }
    }
}
