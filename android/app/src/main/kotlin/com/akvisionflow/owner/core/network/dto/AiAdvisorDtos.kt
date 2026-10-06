package com.akvisionflow.owner.core.network.dto

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// Mirror the exact JSON shapes returned by
// backend/src/modules/mobile/aiAdvisor.routes.js (Phase 4). One flexible DTO
// covers every AI Advisor screen (Home's dailyAdvice/needsAttention/trend,
// Briefing's item, Needs Attention's items, History's items, Insight
// Detail's item) - the same "one shape, several contexts" pattern already
// used for AlertDto in Phase 3, since these are literally the same
// underlying AiInsight rows viewed through a different lens.

@Serializable
data class AiInsightDto(
    val id: String? = null,
    val insightType: String,
    val severity: String? = null,
    val title: String,
    val summary: String,
    val evidence: JsonElement? = null,
    val recommendedAction: String? = null,
    val confidence: Double? = null,
    val scopeFrom: String? = null,
    val scopeTo: String? = null,
    val status: String? = null,
    val isRead: Boolean = true,
    val isDismissed: Boolean = false,
    val createdAt: String,
    val cached: Boolean = false,
    val rank: Int? = null,
)

@Serializable
data class AiInsightCountsDto(
    val anomaly: Int,
    val risk: Int,
    val opportunity: Int,
    val recommendation: Int,
    val total: Int,
)

@Serializable
data class AiHomeResponse(
    val dailyAdvice: AiInsightDto,
    val needsAttention: List<AiInsightDto> = emptyList(),
    val trend: AiInsightDto? = null,
    val counts: AiInsightCountsDto,
)

@Serializable
data class AiBriefingResponse(
    val item: AiInsightDto,
)

@Serializable
data class AiInsightDetailResponse(
    val item: AiInsightDto,
)

@Serializable
data class AiNeedsAttentionResponse(
    val items: List<AiInsightDto> = emptyList(),
    val total: Int,
)

@Serializable
data class AiHistoryResponse(
    val items: List<AiInsightDto> = emptyList(),
    val total: Int,
    val page: Int,
    val pageSize: Int,
)
