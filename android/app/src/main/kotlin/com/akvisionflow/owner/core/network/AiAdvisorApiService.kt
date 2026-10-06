package com.akvisionflow.owner.core.network

import com.akvisionflow.owner.core.network.dto.AiBriefingResponse
import com.akvisionflow.owner.core.network.dto.AiHistoryResponse
import com.akvisionflow.owner.core.network.dto.AiHomeResponse
import com.akvisionflow.owner.core.network.dto.AiInsightDetailResponse
import com.akvisionflow.owner.core.network.dto.AiNeedsAttentionResponse
import retrofit2.Response
import retrofit2.http.GET
import retrofit2.http.Path
import retrofit2.http.QueryMap

/**
 * The Phase 4 AI Advisor API - entirely read-only. Marking an AI insight
 * read/dismissed reuses the Phase 3 [AlertsApiService] endpoints (same
 * underlying AiInsight rows), not duplicated here.
 */
interface AiAdvisorApiService {

    @GET("ai/home")
    suspend fun getHome(@QueryMap filters: Map<String, String>): Response<AiHomeResponse>

    @GET("ai/briefing")
    suspend fun getBriefing(@QueryMap filters: Map<String, String>): Response<AiBriefingResponse>

    @GET("ai/needs-attention")
    suspend fun getNeedsAttention(): Response<AiNeedsAttentionResponse>

    @GET("ai/history")
    suspend fun getHistory(@QueryMap filters: Map<String, String>): Response<AiHistoryResponse>

    @GET("ai/insights/{id}")
    suspend fun getInsight(@Path("id") id: String): Response<AiInsightDetailResponse>
}
