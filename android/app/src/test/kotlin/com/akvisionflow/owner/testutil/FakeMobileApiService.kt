package com.akvisionflow.owner.testutil

import com.akvisionflow.owner.core.network.MobileApiService
import com.akvisionflow.owner.core.network.dto.ContextResponse
import com.akvisionflow.owner.core.network.dto.HealthResponse
import com.akvisionflow.owner.core.network.dto.LoginRequest
import com.akvisionflow.owner.core.network.dto.LoginResponse
import com.akvisionflow.owner.core.network.dto.LogoutResponse
import com.akvisionflow.owner.core.network.dto.ProfileResponse
import retrofit2.Response

/** In-memory fake used by repository/viewmodel tests - no real HTTP involved. */
class FakeMobileApiService(
    private var healthResponse: Response<HealthResponse>? = null,
    private var loginResponse: Response<LoginResponse>? = null,
    private var logoutResponse: Response<LogoutResponse>? = null,
    private var profileResponse: Response<ProfileResponse>? = null,
    private var contextResponse: Response<ContextResponse>? = null,
) : MobileApiService {

    var contextCallCount = 0
        private set

    fun setContextResponse(response: Response<ContextResponse>) {
        contextResponse = response
    }

    var loginCallCount = 0
        private set
    var profileCallCount = 0
        private set
    var lastLoginRequest: LoginRequest? = null
        private set

    fun setProfileResponse(response: Response<ProfileResponse>) {
        profileResponse = response
    }

    override suspend fun health(): Response<HealthResponse> =
        healthResponse ?: error("health() not stubbed")

    override suspend fun login(body: LoginRequest): Response<LoginResponse> {
        loginCallCount++
        lastLoginRequest = body
        return loginResponse ?: error("login() not stubbed")
    }

    override suspend fun logout(): Response<LogoutResponse> =
        logoutResponse ?: error("logout() not stubbed")

    override suspend fun context(): Response<ContextResponse> {
        contextCallCount++
        return contextResponse ?: error("context() not stubbed")
    }

    override suspend fun profile(): Response<ProfileResponse> {
        profileCallCount++
        return profileResponse ?: error("profile() not stubbed")
    }
}
