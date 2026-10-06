package com.akvisionflow.owner.feature.profile

import com.akvisionflow.owner.core.network.ApiResult
import com.akvisionflow.owner.core.network.ApiResultMapper
import com.akvisionflow.owner.core.network.dto.OwnerProfileDto
import com.akvisionflow.owner.core.network.dto.PermissionsDto
import com.akvisionflow.owner.core.network.dto.ProfileResponse
import com.akvisionflow.owner.core.network.dto.TenantSummaryDto
import com.akvisionflow.owner.testutil.FakeMobileApiService
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Test
import retrofit2.Response

class ProfileRepositoryTest {

    private val json = Json { ignoreUnknownKeys = true }
    private val mapper = ApiResultMapper(json) {}

    private fun profile(name: String) = ProfileResponse(
        user = OwnerProfileDto("u1", name, "owner@test.local", "TENANT_ADMIN"),
        tenant = TenantSummaryDto("t1", "Shop", "Shop Business", null, "USD", "UTC"),
        branch = null,
        permissions = PermissionsDto(readOnly = true, role = "OWNER_MOBILE"),
    )

    @Test
    fun `first call hits the network and caches the result`() = runTest {
        val api = FakeMobileApiService(profileResponse = Response.success(profile("First Fetch")))
        val repository = ProfileRepository(api, mapper)

        val result = repository.getProfile()

        assertEquals(1, api.profileCallCount)
        assertEquals("First Fetch", (result as ApiResult.Success).data.user.name)
    }

    @Test
    fun `second call without forceRefresh is served from cache, not the network`() = runTest {
        val api = FakeMobileApiService(profileResponse = Response.success(profile("Cached Name")))
        val repository = ProfileRepository(api, mapper)

        repository.getProfile()
        val second = repository.getProfile()

        assertEquals(1, api.profileCallCount)
        assertEquals("Cached Name", (second as ApiResult.Success).data.user.name)
    }

    @Test
    fun `forceRefresh bypasses the cache and re-fetches`() = runTest {
        val api = FakeMobileApiService(profileResponse = Response.success(profile("Old Name")))
        val repository = ProfileRepository(api, mapper)
        repository.getProfile()

        api.setProfileResponse(Response.success(profile("New Name")))
        val refreshed = repository.getProfile(forceRefresh = true)

        assertEquals(2, api.profileCallCount)
        assertEquals("New Name", (refreshed as ApiResult.Success).data.user.name)
    }

    @Test
    fun `a failed fetch does not populate the cache`() = runTest {
        val api = FakeMobileApiService(
            profileResponse = Response.error(
                401,
                """{"error":"Invalid or expired token"}""".toResponseBody("application/json".toMediaType()),
            ),
        )
        val repository = ProfileRepository(api, mapper)

        repository.getProfile()

        assertEquals(null, repository.cachedProfile())
    }

    @Test
    fun `clearCache forces the next call back to the network`() = runTest {
        val api = FakeMobileApiService(profileResponse = Response.success(profile("Name")))
        val repository = ProfileRepository(api, mapper)
        repository.getProfile()

        repository.clearCache()
        repository.getProfile()

        assertEquals(2, api.profileCallCount)
    }
}
