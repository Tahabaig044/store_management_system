package com.akvisionflow.owner.testutil

import com.akvisionflow.owner.core.network.AiAdvisorApiService
import com.akvisionflow.owner.core.network.dto.AiBriefingResponse
import com.akvisionflow.owner.core.network.dto.AiHistoryResponse
import com.akvisionflow.owner.core.network.dto.AiHomeResponse
import com.akvisionflow.owner.core.network.dto.AiInsightDetailResponse
import com.akvisionflow.owner.core.network.dto.AiNeedsAttentionResponse
import retrofit2.Response

/** In-memory fake used by repository/viewmodel tests - no real HTTP involved. */
class FakeAiAdvisorApiService(
    private var homeResponse: Response<AiHomeResponse>? = null,
    private var briefingResponse: Response<AiBriefingResponse>? = null,
    private var needsAttentionResponse: Response<AiNeedsAttentionResponse>? = null,
    private var historyResponse: Response<AiHistoryResponse>? = null,
    private var insightResponse: Response<AiInsightDetailResponse>? = null,
) : AiAdvisorApiService {

    var lastHomeQuery: Map<String, String>? = null
        private set
    var lastBriefingQuery: Map<String, String>? = null
        private set
    var lastHistoryQuery: Map<String, String>? = null
        private set
    var lastInsightId: String? = null
        private set

    override suspend fun getHome(filters: Map<String, String>): Response<AiHomeResponse> {
        lastHomeQuery = filters
        return homeResponse ?: error("getHome() not stubbed")
    }

    override suspend fun getBriefing(filters: Map<String, String>): Response<AiBriefingResponse> {
        lastBriefingQuery = filters
        return briefingResponse ?: error("getBriefing() not stubbed")
    }

    override suspend fun getNeedsAttention(): Response<AiNeedsAttentionResponse> =
        needsAttentionResponse ?: error("getNeedsAttention() not stubbed")

    override suspend fun getHistory(filters: Map<String, String>): Response<AiHistoryResponse> {
        lastHistoryQuery = filters
        return historyResponse ?: error("getHistory() not stubbed")
    }

    override suspend fun getInsight(id: String): Response<AiInsightDetailResponse> {
        lastInsightId = id
        return insightResponse ?: error("getInsight() not stubbed")
    }
}
