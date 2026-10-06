package com.akvisionflow.owner.feature.alerts

import com.akvisionflow.owner.core.data.FakeDeviceIdProvider
import com.akvisionflow.owner.core.network.ApiResult
import com.akvisionflow.owner.core.network.ApiResultMapper
import com.akvisionflow.owner.core.network.dto.AlertDetailResponse
import com.akvisionflow.owner.core.network.dto.AlertDto
import com.akvisionflow.owner.core.network.dto.AlertListResponse
import com.akvisionflow.owner.core.network.dto.DeviceTokenSummary
import com.akvisionflow.owner.core.network.dto.RegisterDeviceResponse
import com.akvisionflow.owner.core.network.dto.UnregisterDeviceResponse
import com.akvisionflow.owner.testutil.FakeAlertsApiService
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test
import retrofit2.Response

class AlertsRepositoryTest {

    private val json = Json { ignoreUnknownKeys = true }
    private val mapper = ApiResultMapper(json) {}

    private fun alert(id: String = "a1") = AlertDto(
        id = id, category = "INVENTORY", priority = "IMPORTANT", title = "Low stock", summary = "...",
        evidence = null, recommendedAction = null, isRead = false, isDismissed = false,
        createdAt = "2026-01-01T00:00:00.000Z", deepLink = "analytics",
    )

    @Test
    fun `listAlerts sends the status filter and unwraps items`() = runTest {
        val api = FakeAlertsApiService(listResponse = Response.success(AlertListResponse(listOf(alert()), 1, 1, 20)))
        val repository = AlertsRepository(api, mapper, FakeDeviceIdProvider())

        val result = repository.listAlerts(status = "unread")

        assertEquals(mapOf("status" to "unread"), api.lastListQuery)
        assertEquals(1, (result as ApiResult.Success).data.items.size)
    }

    @Test
    fun `listAlerts includes priority and category when provided`() = runTest {
        val api = FakeAlertsApiService(listResponse = Response.success(AlertListResponse(emptyList(), 0, 1, 20)))
        val repository = AlertsRepository(api, mapper, FakeDeviceIdProvider())

        repository.listAlerts(status = "all", priority = "CRITICAL", category = "SALES")

        assertEquals(mapOf("status" to "all", "priority" to "CRITICAL", "category" to "SALES"), api.lastListQuery)
    }

    @Test
    fun `markRead unwraps the updated alert`() = runTest {
        val updated = alert().copy(isRead = true)
        val api = FakeAlertsApiService(markReadResponse = Response.success(AlertDetailResponse(updated)))
        val repository = AlertsRepository(api, mapper, FakeDeviceIdProvider())

        val result = repository.markRead("a1")

        assertEquals(true, (result as ApiResult.Success).data.item.isRead)
    }

    @Test
    fun `registerThisDevice sends the device id from the provider`() = runTest {
        val api = FakeAlertsApiService(registerResponse = Response.success(RegisterDeviceResponse(DeviceTokenSummary("d1", "ANDROID", true))))
        val repository = AlertsRepository(api, mapper, FakeDeviceIdProvider("device-xyz"))

        repository.registerThisDevice()

        assertEquals("device-xyz", api.lastRegisterRequest?.token)
        assertEquals("ANDROID", api.lastRegisterRequest?.platform)
    }

    @Test
    fun `unregisterThisDevice sends the same device id`() = runTest {
        val api = FakeAlertsApiService(unregisterResponse = Response.success(UnregisterDeviceResponse("Device unregistered")))
        val repository = AlertsRepository(api, mapper, FakeDeviceIdProvider("device-xyz"))

        repository.unregisterThisDevice()

        assertEquals("device-xyz", api.lastUnregisterRequest?.token)
    }
}
