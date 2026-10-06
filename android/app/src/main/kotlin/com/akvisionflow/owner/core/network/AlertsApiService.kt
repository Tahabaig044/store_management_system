package com.akvisionflow.owner.core.network

import com.akvisionflow.owner.core.network.dto.AlertDetailResponse
import com.akvisionflow.owner.core.network.dto.AlertListResponse
import com.akvisionflow.owner.core.network.dto.NotificationPreferencesResponse
import com.akvisionflow.owner.core.network.dto.RegisterDeviceRequest
import com.akvisionflow.owner.core.network.dto.RegisterDeviceResponse
import com.akvisionflow.owner.core.network.dto.UnregisterDeviceRequest
import com.akvisionflow.owner.core.network.dto.UnregisterDeviceResponse
import com.akvisionflow.owner.core.network.dto.UpdateNotificationPreferencesRequest
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.PUT
import retrofit2.http.Path
import retrofit2.http.POST
import retrofit2.http.QueryMap

/**
 * The Phase 3 alerts/notifications API. Marking an alert read/dismissed and
 * updating notification preferences are the deliberate, documented
 * exceptions to read-only (notification-state/account metadata, never
 * business data - see backend/src/modules/mobile/alerts.routes.js).
 */
interface AlertsApiService {

    @GET("alerts")
    suspend fun listAlerts(@QueryMap filters: Map<String, String>): Response<AlertListResponse>

    @GET("alerts/{id}")
    suspend fun getAlert(@Path("id") id: String): Response<AlertDetailResponse>

    @POST("alerts/{id}/read")
    suspend fun markRead(@Path("id") id: String): Response<AlertDetailResponse>

    @POST("alerts/{id}/dismiss")
    suspend fun dismiss(@Path("id") id: String): Response<AlertDetailResponse>

    @GET("notification-preferences")
    suspend fun getPreferences(): Response<NotificationPreferencesResponse>

    @PUT("notification-preferences")
    suspend fun updatePreferences(@Body body: UpdateNotificationPreferencesRequest): Response<NotificationPreferencesResponse>

    @POST("push/register-device")
    suspend fun registerDevice(@Body body: RegisterDeviceRequest): Response<RegisterDeviceResponse>

    @POST("push/unregister-device")
    suspend fun unregisterDevice(@Body body: UnregisterDeviceRequest): Response<UnregisterDeviceResponse>
}
