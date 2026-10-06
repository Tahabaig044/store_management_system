package com.akvisionflow.owner.testutil

import com.akvisionflow.owner.core.network.AlertsApiService
import com.akvisionflow.owner.core.network.dto.AlertDetailResponse
import com.akvisionflow.owner.core.network.dto.AlertListResponse
import com.akvisionflow.owner.core.network.dto.NotificationPreferencesResponse
import com.akvisionflow.owner.core.network.dto.RegisterDeviceRequest
import com.akvisionflow.owner.core.network.dto.RegisterDeviceResponse
import com.akvisionflow.owner.core.network.dto.UnregisterDeviceRequest
import com.akvisionflow.owner.core.network.dto.UnregisterDeviceResponse
import com.akvisionflow.owner.core.network.dto.UpdateNotificationPreferencesRequest
import retrofit2.Response

/** In-memory fake used by repository/viewmodel tests - no real HTTP involved. */
class FakeAlertsApiService(
    private var listResponse: Response<AlertListResponse>? = null,
    private var detailResponse: Response<AlertDetailResponse>? = null,
    private var markReadResponse: Response<AlertDetailResponse>? = null,
    private var dismissResponse: Response<AlertDetailResponse>? = null,
    private var preferencesResponse: Response<NotificationPreferencesResponse>? = null,
    private var updatePreferencesResponse: Response<NotificationPreferencesResponse>? = null,
    private var registerResponse: Response<RegisterDeviceResponse>? = null,
    private var unregisterResponse: Response<UnregisterDeviceResponse>? = null,
) : AlertsApiService {

    var lastListQuery: Map<String, String>? = null
        private set
    var lastUpdateRequest: UpdateNotificationPreferencesRequest? = null
        private set
    var lastRegisterRequest: RegisterDeviceRequest? = null
        private set
    var lastUnregisterRequest: UnregisterDeviceRequest? = null
        private set

    override suspend fun listAlerts(filters: Map<String, String>): Response<AlertListResponse> {
        lastListQuery = filters
        return listResponse ?: error("listAlerts() not stubbed")
    }

    override suspend fun getAlert(id: String): Response<AlertDetailResponse> = detailResponse ?: error("getAlert() not stubbed")

    override suspend fun markRead(id: String): Response<AlertDetailResponse> = markReadResponse ?: error("markRead() not stubbed")

    override suspend fun dismiss(id: String): Response<AlertDetailResponse> = dismissResponse ?: error("dismiss() not stubbed")

    override suspend fun getPreferences(): Response<NotificationPreferencesResponse> =
        preferencesResponse ?: error("getPreferences() not stubbed")

    override suspend fun updatePreferences(body: UpdateNotificationPreferencesRequest): Response<NotificationPreferencesResponse> {
        lastUpdateRequest = body
        return updatePreferencesResponse ?: error("updatePreferences() not stubbed")
    }

    override suspend fun registerDevice(body: RegisterDeviceRequest): Response<RegisterDeviceResponse> {
        lastRegisterRequest = body
        return registerResponse ?: error("registerDevice() not stubbed")
    }

    override suspend fun unregisterDevice(body: UnregisterDeviceRequest): Response<UnregisterDeviceResponse> {
        lastUnregisterRequest = body
        return unregisterResponse ?: error("unregisterDevice() not stubbed")
    }
}
