package com.akvisionflow.owner.feature.aiadvisor

import com.akvisionflow.owner.core.network.ApiResult
import com.akvisionflow.owner.core.network.ApiResultMapper
import com.akvisionflow.owner.core.network.dto.AiBriefingResponse
import com.akvisionflow.owner.core.network.dto.AiHistoryResponse
import com.akvisionflow.owner.core.network.dto.AiInsightDetailResponse
import com.akvisionflow.owner.core.network.dto.AiInsightDto
import com.akvisionflow.owner.testutil.FakeAiAdvisorApiService
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test
import retrofit2.Response

class AiAdvisorRepositoryTest {

    private val json = Json { ignoreUnknownKeys = true }
    private val mapper = ApiResultMapper(json) {}

    private fun insight(id: String = "i1") = AiInsightDto(
        id = id, insightType = "RISK", title = "Low stock", summary = "...",
        createdAt = "2026-01-01T00:00:00.000Z",
    )

    @Test
    fun `getBriefing omits forceRegenerate when false`() = runTest {
        val api = FakeAiAdvisorApiService(briefingResponse = Response.success(AiBriefingResponse(insight())))
        val repository = AiAdvisorRepository(api, mapper)

        repository.getBriefing()

        assertEquals(emptyMap<String, String>(), api.lastBriefingQuery)
    }

    @Test
    fun `getBriefing includes forceRegenerate when true`() = runTest {
        val api = FakeAiAdvisorApiService(briefingResponse = Response.success(AiBriefingResponse(insight())))
        val repository = AiAdvisorRepository(api, mapper)

        repository.getBriefing(forceRegenerate = true)

        assertEquals(mapOf("forceRegenerate" to "true"), api.lastBriefingQuery)
    }

    @Test
    fun `getHistory sends the type filter and page`() = runTest {
        val api = FakeAiAdvisorApiService(historyResponse = Response.success(AiHistoryResponse(emptyList(), 0, 1, 20)))
        val repository = AiAdvisorRepository(api, mapper)

        repository.getHistory(insightType = "ANOMALY", page = 2)

        assertEquals(mapOf("insightType" to "ANOMALY", "page" to "2"), api.lastHistoryQuery)
    }

    @Test
    fun `getInsight forwards the id and unwraps the item`() = runTest {
        val api = FakeAiAdvisorApiService(insightResponse = Response.success(AiInsightDetailResponse(insight("abc"))))
        val repository = AiAdvisorRepository(api, mapper)

        val result = repository.getInsight("abc")

        assertEquals("abc", api.lastInsightId)
        assertEquals("abc", (result as ApiResult.Success).data.item.id)
    }
}
