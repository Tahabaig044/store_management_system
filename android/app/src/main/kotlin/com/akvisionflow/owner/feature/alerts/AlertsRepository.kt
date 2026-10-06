package com.akvisionflow.owner.feature.alerts

import com.akvisionflow.owner.core.data.DeviceIdProvider
import com.akvisionflow.owner.core.network.ApiResult
import com.akvisionflow.owner.core.network.ApiResultMapper
import com.akvisionflow.owner.core.network.AlertsApiService
import com.akvisionflow.owner.core.network.dto.AlertDetailResponse
import com.akvisionflow.owner.core.network.dto.AlertListResponse
import com.akvisionflow.owner.core.network.dto.NotificationPreferencesResponse
import com.akvisionflow.owner.core.network.dto.RegisterDeviceRequest
import com.akvisionflow.owner.core.network.dto.RegisterDeviceResponse
import com.akvisionflow.owner.core.network.dto.UnregisterDeviceRequest
import com.akvisionflow.owner.core.network.dto.UnregisterDeviceResponse
import com.akvisionflow.owner.core.network.dto.UpdateNotificationPreferencesRequest

class AlertsRepository(
    private val api: AlertsApiService,
    private val resultMapper: ApiResultMapper,
    private val deviceIdProvider: DeviceIdProvider,
) {
    suspend fun listAlerts(status: String = "all", priority: String? = null, category: String? = null, important: Boolean = false): ApiResult<AlertListResponse> {
        val query = buildMap {
            put("status", status)
            if (important) put("important", "true")
            priority?.let { put("priority", it) }
            category?.let { put("category", it) }
        }
        return resultMapper.execute { api.listAlerts(query) }
    }

    suspend fun getAlert(id: String): ApiResult<AlertDetailResponse> = resultMapper.execute { api.getAlert(id) }

    suspend fun markRead(id: String): ApiResult<AlertDetailResponse> = resultMapper.execute { api.markRead(id) }

    suspend fun dismiss(id: String): ApiResult<AlertDetailResponse> = resultMapper.execute { api.dismiss(id) }

    suspend fun getPreferences(): ApiResult<NotificationPreferencesResponse> = resultMapper.execute { api.getPreferences() }

    suspend fun updatePreferences(update: UpdateNotificationPreferencesRequest): ApiResult<NotificationPreferencesResponse> =
        resultMapper.execute { api.updatePreferences(update) }

    suspend fun registerThisDevice(): ApiResult<RegisterDeviceResponse> =
        resultMapper.execute { api.registerDevice(RegisterDeviceRequest(token = deviceIdProvider.getOrCreateId())) }

    suspend fun unregisterThisDevice(): ApiResult<UnregisterDeviceResponse> =
        resultMapper.execute { api.unregisterDevice(UnregisterDeviceRequest(token = deviceIdProvider.getOrCreateId())) }
}
