package com.akvisionflow.owner.feature.aiadvisor

import com.akvisionflow.owner.core.network.AiAdvisorApiService
import com.akvisionflow.owner.core.network.ApiResult
import com.akvisionflow.owner.core.network.ApiResultMapper
import com.akvisionflow.owner.core.network.dto.AiBriefingResponse
import com.akvisionflow.owner.core.network.dto.AiHistoryResponse
import com.akvisionflow.owner.core.network.dto.AiHomeResponse
import com.akvisionflow.owner.core.network.dto.AiInsightDetailResponse
import com.akvisionflow.owner.core.network.dto.AiNeedsAttentionResponse

class AiAdvisorRepository(
    private val api: AiAdvisorApiService,
    private val resultMapper: ApiResultMapper,
) {
    suspend fun getHome(branchId: String? = null): ApiResult<AiHomeResponse> =
        resultMapper.execute { api.getHome(buildMap { branchId?.let { put("branchId", it) } }) }

    suspend fun getBriefing(branchId: String? = null, forceRegenerate: Boolean = false): ApiResult<AiBriefingResponse> =
        resultMapper.execute {
            api.getBriefing(
                buildMap {
                    branchId?.let { put("branchId", it) }
                    if (forceRegenerate) put("forceRegenerate", "true")
                },
            )
        }

    suspend fun getNeedsAttention(): ApiResult<AiNeedsAttentionResponse> =
        resultMapper.execute { api.getNeedsAttention() }

    suspend fun getHistory(insightType: String? = null, page: Int = 1): ApiResult<AiHistoryResponse> =
        resultMapper.execute {
            api.getHistory(
                buildMap {
                    insightType?.let { put("insightType", it) }
                    put("page", page.toString())
                },
            )
        }

    suspend fun getInsight(id: String): ApiResult<AiInsightDetailResponse> =
        resultMapper.execute { api.getInsight(id) }
}
