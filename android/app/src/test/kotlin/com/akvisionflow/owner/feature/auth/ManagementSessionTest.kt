package com.akvisionflow.owner.feature.auth

import com.akvisionflow.owner.core.data.InMemorySessionContextStore
import com.akvisionflow.owner.core.data.InMemoryTokenStore
import com.akvisionflow.owner.core.data.SessionRepository
import com.akvisionflow.owner.core.network.ApiErrorKind
import com.akvisionflow.owner.core.network.ApiResult
import com.akvisionflow.owner.core.network.ApiResultMapper
import com.akvisionflow.owner.core.network.dto.AccessDto
import com.akvisionflow.owner.core.network.dto.LoginResponse
import com.akvisionflow.owner.core.network.dto.OwnerProfileDto
import com.akvisionflow.owner.core.network.dto.OwnerUserDto
import com.akvisionflow.owner.core.network.dto.PermissionsDto
import com.akvisionflow.owner.core.network.dto.ProfileResponse
import com.akvisionflow.owner.core.network.dto.TenantSummaryDto
import com.akvisionflow.owner.feature.profile.ProfileRepository
import com.akvisionflow.owner.feature.profile.roleLabel
import com.akvisionflow.owner.testutil.FakeMobileApiService
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

class ManagementSessionTest {

    private val json = Json { ignoreUnknownKeys = true }
    private val tenant = TenantSummaryDto("t1", "Shop", "Shop Business", null, "PKR", "UTC")

    private fun login(access: AccessDto?) = LoginResponse(
        token = "mobile-jwt",
        user = OwnerUserDto("u1", "Mira", "mira@shop.test", "MANAGER"),
        tenant = tenant,
        permissions = PermissionsDto(readOnly = true, role = "OWNER_MOBILE"),
        access = access,
    )

    @Test
    fun `signing in as a manager builds the session context from the server's access and then runs the sign-in hook`() = runTest {
        val session = SessionRepository(InMemoryTokenStore(), InMemorySessionContextStore())
        val api = FakeMobileApiService(loginResponse = Response.success(login(AccessDto("MANAGER", listOf("REPORT:VIEW")))))
        var hookRole: String? = null
        val repo = AuthRepository(api, ApiResultMapper(json) {}, session) { hookRole = it.role }

        val result = repo.login("mira@shop.test", "pw")

        assertTrue(result is ApiResult.Success)
        assertEquals("MANAGER", session.context.value!!.role)
        assertTrue(session.context.value!!.can("REPORT:VIEW"))
        assertEquals("MANAGER", hookRole)
    }

    @Test
    fun `a sign-in hook that fails never fails the sign-in`() = runTest {
        val session = SessionRepository(InMemoryTokenStore(), InMemorySessionContextStore())
        val api = FakeMobileApiService(loginResponse = Response.success(login(AccessDto("MANAGER"))))
        val repo = AuthRepository(api, ApiResultMapper(json) {}, session) { error("context load failed") }
        assertTrue(repo.login("mira@shop.test", "pw") is ApiResult.Success)
        assertEquals(com.akvisionflow.owner.core.data.SessionState.Authenticated, session.state.value)
    }

    @Test
    fun `a profile refresh that reports changed access updates the session - a revoked grant disappears at once`() = runTest {
        val session = SessionRepository(InMemoryTokenStore("tok"), InMemorySessionContextStore())
        session.onLoginSuccess("tok", com.akvisionflow.owner.core.data.SessionContext.from(login(AccessDto("MANAGER", listOf("REPORT:VIEW", "SALE:VIEW")))))
        val profile = ProfileResponse(
            user = OwnerProfileDto("u1", "Mira", "mira@shop.test", "MANAGER"),
            tenant = tenant,
            permissions = PermissionsDto(true, "OWNER_MOBILE"),
            access = AccessDto("MANAGER", listOf("SALE:VIEW")),
        )
        val repo = ProfileRepository(FakeMobileApiService(profileResponse = Response.success(profile)), ApiResultMapper(json) {}, session)

        repo.getProfile(forceRefresh = true)

        assertFalse(session.context.value!!.can("REPORT:VIEW"))
        assertTrue(session.context.value!!.can("SALE:VIEW"))
    }

    @Test
    fun `the backend's machine-readable code reaches the caller alongside the message`() = runTest {
        val mapper = ApiResultMapper(json) {}
        val body = """{"error":"Choose a branch","code":"BRANCH_REQUIRED"}""".toResponseBody("application/json".toMediaType())
        val result = mapper.execute<String> { Response.error(422, body) }
        val error = result as ApiResult.Error
        assertEquals(ApiErrorKind.VALIDATION, error.kind)
        assertEquals("Choose a branch", error.message)
        assertEquals("BRANCH_REQUIRED", error.code)
    }

    @Test
    fun `roles are shown in plain language, as view-only for now`() {
        assertEquals("Owner (view only)", roleLabel("TENANT_ADMIN"))
        assertEquals("Manager (view only)", roleLabel("MANAGER"))
    }
}
