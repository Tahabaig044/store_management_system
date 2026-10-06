package com.akvisionflow.owner.feature.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.akvisionflow.owner.core.network.ApiResult
import com.akvisionflow.owner.feature.alerts.AlertsRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class LoginUiState(
    val email: String = "",
    val password: String = "",
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
    val loginSucceeded: Boolean = false,
)

class LoginViewModel(
    private val authRepository: AuthRepository,
    private val alertsRepository: AlertsRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow(LoginUiState())
    val uiState: StateFlow<LoginUiState> = _uiState.asStateFlow()

    fun onEmailChange(value: String) {
        _uiState.value = _uiState.value.copy(email = value, errorMessage = null)
    }

    fun onPasswordChange(value: String) {
        _uiState.value = _uiState.value.copy(password = value, errorMessage = null)
    }

    fun submit() {
        val state = _uiState.value
        if (state.email.isBlank() || state.password.isBlank()) {
            _uiState.value = state.copy(errorMessage = "Enter your email and password.")
            return
        }
        if (state.isLoading) return

        _uiState.value = state.copy(isLoading = true, errorMessage = null)
        viewModelScope.launch {
            when (val result = authRepository.login(state.email, state.password)) {
                is ApiResult.Success -> {
                    _uiState.value = _uiState.value.copy(isLoading = false, loginSucceeded = true)
                    // Best-effort: a failed device registration shouldn't block
                    // sign-in, just means this device won't receive push alerts
                    // until the next successful call (e.g. next app open).
                    alertsRepository.registerThisDevice()
                }
                is ApiResult.Error -> {
                    _uiState.value = _uiState.value.copy(isLoading = false, errorMessage = result.message)
                }
            }
        }
    }
}
