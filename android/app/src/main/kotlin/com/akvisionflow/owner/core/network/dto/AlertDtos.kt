package com.akvisionflow.owner.core.network.dto

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// Mirror the exact JSON shapes returned by
// backend/src/modules/mobile/{alerts,notificationPreferences,pushRegistration}.routes.js.

@Serializable
data class AlertDto(
    val id: String,
    val category: String,
    val priority: String,
    val title: String,
    val summary: String,
    val evidence: JsonElement? = null,
    val recommendedAction: String? = null,
    val isRead: Boolean,
    val isDismissed: Boolean,
    val createdAt: String,
    val acknowledgedAt: String? = null,
    val dismissedAt: String? = null,
    val deepLink: String,
)

@Serializable
data class AlertListResponse(
    val items: List<AlertDto>,
    val total: Int,
    val page: Int,
    val pageSize: Int,
)

@Serializable
data class AlertDetailResponse(
    val item: AlertDto,
)

@Serializable
data class NotificationPreferencesDto(
    val dailySummaryEnabled: Boolean,
    val dailySummaryTime: String,
    val salesAlertsEnabled: Boolean,
    val profitAlertsEnabled: Boolean,
    val receivableAlertsEnabled: Boolean,
    val inventoryAlertsEnabled: Boolean,
    val expenseAnomalyAlertsEnabled: Boolean,
    val minimumPriority: String,
)

@Serializable
data class NotificationPreferencesResponse(
    val item: NotificationPreferencesDto,
)

/**
 * A partial update - every field is optional so only the changed
 * preferences are sent. Requires [kotlinx.serialization.json.Json]'s
 * `explicitNulls = false` (see NetworkModule) so an unset field is omitted
 * from the request body entirely, rather than sent as a JSON `null` the
 * backend's zod schema would reject for non-nullable optional fields.
 */
@Serializable
data class UpdateNotificationPreferencesRequest(
    val dailySummaryEnabled: Boolean? = null,
    val dailySummaryTime: String? = null,
    val salesAlertsEnabled: Boolean? = null,
    val profitAlertsEnabled: Boolean? = null,
    val receivableAlertsEnabled: Boolean? = null,
    val inventoryAlertsEnabled: Boolean? = null,
    val expenseAnomalyAlertsEnabled: Boolean? = null,
    val minimumPriority: String? = null,
)

@Serializable
data class RegisterDeviceRequest(
    val token: String,
    val platform: String = "ANDROID",
)

@Serializable
data class UnregisterDeviceRequest(
    val token: String,
)

@Serializable
data class DeviceTokenSummary(
    val id: String,
    val platform: String,
    val isActive: Boolean,
)

@Serializable
data class RegisterDeviceResponse(
    val item: DeviceTokenSummary,
)

@Serializable
data class UnregisterDeviceResponse(
    val message: String,
)
