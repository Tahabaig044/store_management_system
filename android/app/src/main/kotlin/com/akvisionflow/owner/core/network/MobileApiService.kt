package com.akvisionflow.owner.core.network

import com.akvisionflow.owner.core.network.dto.ContextResponse
import com.akvisionflow.owner.core.network.dto.HealthResponse
import com.akvisionflow.owner.core.network.dto.LoginRequest
import com.akvisionflow.owner.core.network.dto.LoginResponse
import com.akvisionflow.owner.core.network.dto.LogoutResponse
import com.akvisionflow.owner.core.network.dto.ProfileResponse
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST

/**
 * Every call to the VisionFlow backend the Owner app makes in Phase 1.
 * Deliberately small and read-only: there is no write endpoint here to add
 * by mistake, matching the phase's read-only requirement at the client's
 * own contract layer (the backend enforces it independently - see
 * mobileReadOnlyGuard on the server).
 */
interface MobileApiService {

    @GET("health")
    suspend fun health(): Response<HealthResponse>

    @POST("auth/login")
    suspend fun login(@Body body: LoginRequest): Response<LoginResponse>

    @POST("auth/logout")
    suspend fun logout(): Response<LogoutResponse>

    @GET("profile")
    suspend fun profile(): Response<ProfileResponse>

    /** The company/branch context this session works within (Phase 4.1). */
    @GET("context")
    suspend fun context(): Response<ContextResponse>
}
