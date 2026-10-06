package com.akvisionflow.owner.feature.profile

import com.akvisionflow.owner.core.data.SessionRepository
import com.akvisionflow.owner.core.data.refreshedFrom
import com.akvisionflow.owner.core.network.ApiResult
import com.akvisionflow.owner.core.network.ApiResultMapper
import com.akvisionflow.owner.core.network.MobileApiService
import com.akvisionflow.owner.core.network.dto.ProfileResponse

class ProfileRepository(
    private val api: MobileApiService,
    private val resultMapper: ApiResultMapper,
    // Phase 4.1: what the server says about this session (role, grants, branch scope) keeps the app's copy current.
    private val sessionRepository: SessionRepository? = null,
) {
    // Simple in-memory, session-lifetime cache: the owner's profile rarely
    // changes between app opens, so re-entering the Profile tab shows the
    // last-known data instantly while a fresh copy loads in the background -
    // the Phase 1 "basic caching strategy" foundation, deliberately without
    // a full local database this early.
    private var cached: ProfileResponse? = null

    suspend fun getProfile(forceRefresh: Boolean = false): ApiResult<ProfileResponse> {
        val cachedValue = cached
        if (!forceRefresh && cachedValue != null) {
            return ApiResult.Success(cachedValue)
        }
        val result = resultMapper.execute { api.profile() }
        if (result is ApiResult.Success) {
            cached = result.data
            sessionRepository?.let { s -> s.context.value?.let { c -> s.updateContext(c.refreshedFrom(result.data)) } }
        }
        return result
    }

    fun cachedProfile(): ProfileResponse? = cached

    fun clearCache() {
        cached = null
    }
}
