package com.akvisionflow.owner.feature.alerts

import com.akvisionflow.owner.core.data.FakeDeviceIdProvider
import com.akvisionflow.owner.core.network.ApiResultMapper
import com.akvisionflow.owner.core.network.dto.AlertDetailResponse
import com.akvisionflow.owner.core.network.dto.AlertDto
import com.akvisionflow.owner.core.network.dto.AlertListResponse
import com.akvisionflow.owner.testutil.FakeAlertsApiService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import retrofit2.Response

@OptIn(ExperimentalCoroutinesApi::class)
class AlertsViewModelTest {

    private val dispatcher = StandardTestDispatcher()
    private val json = Json { ignoreUnknownKeys = true }

    @Before
    fun setUp() { Dispatchers.setMain(dispatcher) }

    @After
    fun tearDown() { Dispatchers.resetMain() }

    private fun alert(id: String, priority: String = "IMPORTANT", isRead: Boolean = false) = AlertDto(
        id = id, category = "INVENTORY", priority = priority, title = "Alert $id", summary = "...",
        evidence = null, recommendedAction = null, isRead = isRead, isDismissed = false,
        createdAt = "2026-01-01T00:00:00.000Z", deepLink = "analytics",
    )

    @Test
    fun `loads alerts on init`() = runTest {
        val api = FakeAlertsApiService(listResponse = Response.success(AlertListResponse(listOf(alert("a1")), 1, 1, 20)))
        val viewModel = AlertsViewModel(AlertsRepository(api, ApiResultMapper(json) {}, FakeDeviceIdProvider()))

        dispatcher.scheduler.advanceUntilIdle()

        assertEquals(1, viewModel.uiState.value.alerts.size)
        assertEquals(false, viewModel.uiState.value.isLoading)
    }

    @Test
    fun `markRead updates the alert in place without refetching`() = runTest {
        val api = FakeAlertsApiService(
            listResponse = Response.success(AlertListResponse(listOf(alert("a1")), 1, 1, 20)),
            markReadResponse = Response.success(AlertDetailResponse(alert("a1", isRead = true))),
        )
        val viewModel = AlertsViewModel(AlertsRepository(api, ApiResultMapper(json) {}, FakeDeviceIdProvider()))
        dispatcher.scheduler.advanceUntilIdle()

        viewModel.markRead("a1")
        dispatcher.scheduler.advanceUntilIdle()

        assertTrue(viewModel.uiState.value.alerts.first().isRead)
    }

    @Test
    fun `dismiss removes the alert from the visible list`() = runTest {
        val api = FakeAlertsApiService(
            listResponse = Response.success(AlertListResponse(listOf(alert("a1")), 1, 1, 20)),
            dismissResponse = Response.success(AlertDetailResponse(alert("a1").copy(isDismissed = true))),
        )
        val viewModel = AlertsViewModel(AlertsRepository(api, ApiResultMapper(json) {}, FakeDeviceIdProvider()))
        dispatcher.scheduler.advanceUntilIdle()

        viewModel.dismiss("a1")
        dispatcher.scheduler.advanceUntilIdle()

        assertTrue(viewModel.uiState.value.alerts.isEmpty())
    }

    @Test
    fun `setStatusFilter reloads with the new filter`() = runTest {
        val api = FakeAlertsApiService(listResponse = Response.success(AlertListResponse(emptyList(), 0, 1, 20)))
        val viewModel = AlertsViewModel(AlertsRepository(api, ApiResultMapper(json) {}, FakeDeviceIdProvider()))
        dispatcher.scheduler.advanceUntilIdle()

        viewModel.setStatusFilter("unread")
        dispatcher.scheduler.advanceUntilIdle()

        assertEquals("unread", api.lastListQuery?.get("status"))
    }
}
