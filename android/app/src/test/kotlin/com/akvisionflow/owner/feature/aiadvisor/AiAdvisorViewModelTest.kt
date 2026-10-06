package com.akvisionflow.owner.feature.aiadvisor

import com.akvisionflow.owner.core.data.FakeDeviceIdProvider
import com.akvisionflow.owner.core.network.ApiResultMapper
import com.akvisionflow.owner.core.network.dto.AiBriefingResponse
import com.akvisionflow.owner.core.network.dto.AiHistoryResponse
import com.akvisionflow.owner.core.network.dto.AiHomeResponse
import com.akvisionflow.owner.core.network.dto.AiInsightCountsDto
import com.akvisionflow.owner.core.network.dto.AiInsightDetailResponse
import com.akvisionflow.owner.core.network.dto.AiInsightDto
import com.akvisionflow.owner.core.network.dto.AiNeedsAttentionResponse
import com.akvisionflow.owner.core.network.dto.AlertDetailResponse
import com.akvisionflow.owner.core.network.dto.AlertDto
import com.akvisionflow.owner.feature.alerts.AlertsRepository
import com.akvisionflow.owner.testutil.FakeAiAdvisorApiService
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
class AiAdvisorViewModelTest {

    private val dispatcher = StandardTestDispatcher()
    private val json = Json { ignoreUnknownKeys = true }

    @Before
    fun setUp() { Dispatchers.setMain(dispatcher) }

    @After
    fun tearDown() { Dispatchers.resetMain() }

    private fun insight(id: String = "i1", insightType: String = "PERFORMANCE") = AiInsightDto(
        id = id, insightType = insightType, title = "Today's Business Advice", summary = "...",
        createdAt = "2026-01-01T00:00:00.000Z",
    )

    @Test
    fun `AiAdvisorViewModel loads home on init`() = runTest {
        val home = AiHomeResponse(
            dailyAdvice = insight(),
            needsAttention = listOf(insight("i2", "RISK")),
            trend = null,
            counts = AiInsightCountsDto(0, 1, 0, 0, 1),
        )
        val api = FakeAiAdvisorApiService(homeResponse = Response.success(home))
        val viewModel = AiAdvisorViewModel(AiAdvisorRepository(api, ApiResultMapper(json) {}))

        dispatcher.scheduler.advanceUntilIdle()

        assertEquals(1, viewModel.uiState.value.home?.needsAttention?.size)
        assertEquals(false, viewModel.uiState.value.isLoading)
    }

    @Test
    fun `AiNeedsAttentionViewModel loads the full list`() = runTest {
        val api = FakeAiAdvisorApiService(
            needsAttentionResponse = Response.success(AiNeedsAttentionResponse(listOf(insight("i2", "RISK"), insight("i3", "ANOMALY")), 2)),
        )
        val viewModel = AiNeedsAttentionViewModel(AiAdvisorRepository(api, ApiResultMapper(json) {}))

        dispatcher.scheduler.advanceUntilIdle()

        assertEquals(2, viewModel.uiState.value.items.size)
    }

    @Test
    fun `AiHistoryViewModel reloads when the type filter changes`() = runTest {
        val api = FakeAiAdvisorApiService(historyResponse = Response.success(AiHistoryResponse(emptyList(), 0, 1, 20)))
        val viewModel = AiHistoryViewModel(AiAdvisorRepository(api, ApiResultMapper(json) {}))
        dispatcher.scheduler.advanceUntilIdle()

        viewModel.setTypeFilter("ANOMALY")
        dispatcher.scheduler.advanceUntilIdle()

        assertEquals("ANOMALY", api.lastHistoryQuery?.get("insightType"))
        assertEquals("ANOMALY", viewModel.uiState.value.typeFilter)
    }

    @Test
    fun `AiBriefingViewModel forceRegenerate passes through to the repository`() = runTest {
        val api = FakeAiAdvisorApiService(
            briefingResponse = Response.success(AiBriefingResponse(insight())),
        )
        val viewModel = AiBriefingViewModel(AiAdvisorRepository(api, ApiResultMapper(json) {}))
        dispatcher.scheduler.advanceUntilIdle()

        viewModel.load(forceRegenerate = true)
        dispatcher.scheduler.advanceUntilIdle()

        assertEquals("true", api.lastBriefingQuery?.get("forceRegenerate"))
    }

    @Test
    fun `AiInsightDetailViewModel loads the insight by id and can dismiss it`() = runTest {
        val aiApi = FakeAiAdvisorApiService(insightResponse = Response.success(AiInsightDetailResponse(insight("i1", "RISK"))))
        val alertsApi = FakeAlertsApiService(
            dismissResponse = Response.success(
                AlertDetailResponse(
                    AlertDto(
                        id = "i1", category = "INVENTORY", priority = "IMPORTANT", title = "t", summary = "s",
                        isRead = true, isDismissed = true, createdAt = "2026-01-01T00:00:00.000Z", deepLink = "analytics",
                    ),
                ),
            ),
        )
        val viewModel = AiInsightDetailViewModel(
            AiAdvisorRepository(aiApi, ApiResultMapper(json) {}),
            AlertsRepository(alertsApi, ApiResultMapper(json) {}, FakeDeviceIdProvider()),
            "i1",
        )
        dispatcher.scheduler.advanceUntilIdle()
        assertEquals("i1", viewModel.uiState.value.insight?.id)

        viewModel.dismiss()
        dispatcher.scheduler.advanceUntilIdle()

        assertTrue(viewModel.uiState.value.insight?.isDismissed == true)
        assertEquals(false, viewModel.uiState.value.isActing)
    }
}
