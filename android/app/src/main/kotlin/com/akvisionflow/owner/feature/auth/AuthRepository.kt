package com.akvisionflow.owner.feature.auth

import com.akvisionflow.owner.core.data.SessionContext
import com.akvisionflow.owner.core.data.SessionRepository
import com.akvisionflow.owner.core.network.ApiResult
import com.akvisionflow.owner.core.network.ApiResultMapper
import com.akvisionflow.owner.core.network.MobileApiService
import com.akvisionflow.owner.core.network.dto.LoginRequest
import com.akvisionflow.owner.core.network.dto.LoginResponse

class AuthRepository(
    private val api: MobileApiService,
    private val resultMapper: ApiResultMapper,
    private val sessionRepository: SessionRepository,
    // Runs once a session exists (e.g. to load the company/branch context). Never affects the login result.
    private val onSignedIn: suspend (SessionContext) -> Unit = {},
) {
    suspend fun login(email: String, password: String): ApiResult<LoginResponse> {
        val result = resultMapper.execute { api.login(LoginRequest(email.trim(), password)) }
        if (result is ApiResult.Success) {
            val context = SessionContext.from(result.data)
            sessionRepository.onLoginSuccess(result.data.token, context)
            runCatching { onSignedIn(context) }
        }
        return result
    }

    /**
     * Always clears the local session, even if the network call fails -
     * a signed-out device must never be left holding a usable token just
     * because the logout request didn't reach the server.
     */
    suspend fun logout() {
        resultMapper.execute { api.logout() }
        sessionRepository.onLogout()
    }
}
