package com.akvisionflow.owner.feature.auth

import com.akvisionflow.owner.core.data.InMemoryTokenStore
import com.akvisionflow.owner.core.data.SessionRepository
import com.akvisionflow.owner.core.data.SessionState
import com.akvisionflow.owner.core.network.ApiErrorKind
import com.akvisionflow.owner.core.network.ApiResult
import com.akvisionflow.owner.core.network.ApiResultMapper
import com.akvisionflow.owner.core.network.dto.LoginResponse
import com.akvisionflow.owner.core.network.dto.LogoutResponse
import com.akvisionflow.owner.core.network.dto.OwnerUserDto
import com.akvisionflow.owner.core.network.dto.PermissionsDto
import com.akvisionflow.owner.core.network.dto.TenantSummaryDto
import com.akvisionflow.owner.testutil.FakeMobileApiService
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import retrofit2.Response

class AuthRepositoryTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun sessionRepo(store: InMemoryTokenStore = InMemoryTokenStore()) = SessionRepository(store)

    @Test
    fun `successful login stores the token and flips the session to Authenticated`() = runTest {
        val store = InMemoryTokenStore()
        val session = sessionRepo(store)
        val loginResponse = LoginResponse(
            token = "mobile-jwt",
            user = OwnerUserDto("u1", "Test Owner", "owner@test.local", "TENANT_ADMIN"),
            tenant = TenantSummaryDto("t1", "Test Shop", "Test Shop Business", null, "USD", "UTC"),
            permissions = PermissionsDto(readOnly = true, role = "OWNER_MOBILE"),
        )
        val api = FakeMobileApiService(loginResponse = Response.success(loginResponse))
        val mapper = ApiResultMapper(json) { session.onUnauthorized() }
        val repository = AuthRepository(api, mapper, session)

        val result = repository.login("owner@test.local", "password123")

        assertEquals(ApiResult.Success(loginResponse), result)
        assertEquals("mobile-jwt", store.getToken())
        assertEquals(SessionState.Authenticated, session.state.value)
        assertEquals(1, api.loginCallCount)
    }

    @Test
    fun `login trims the email before sending it`() = runTest {
        val api = FakeMobileApiService(
            loginResponse = Response.error(
                401,
                """{"error":"Invalid email or password"}""".toResponseBody("application/json".toMediaType()),
            ),
        )
        val session = sessionRepo()
        val repository = AuthRepository(api, ApiResultMapper(json) { session.onUnauthorized() }, session)

        repository.login("  owner@test.local  ", "password123")

        assertEquals("owner@test.local", api.lastLoginRequest?.email)
    }

    @Test
    fun `failed login does not store a token or authenticate the session`() = runTest {
        val store = InMemoryTokenStore()
        val session = sessionRepo(store)
        val api = FakeMobileApiService(
            loginResponse = Response.error(
                401,
                """{"error":"Invalid email or password"}""".toResponseBody("application/json".toMediaType()),
            ),
        )
        val repository = AuthRepository(api, ApiResultMapper(json) { session.onUnauthorized() }, session)

        val result = repository.login("owner@test.local", "wrong-password")

        assertEquals(ApiErrorKind.UNAUTHORIZED, (result as ApiResult.Error).kind)
        assertNull(store.getToken())
        assertEquals(SessionState.LoggedOut, session.state.value)
    }

    @Test
    fun `logout clears the local session even if the network call fails`() = runTest {
        val store = InMemoryTokenStore(initial = "existing-token")
        val session = sessionRepo(store)
        val api = FakeMobileApiService(logoutResponse = Response.error(500, "".toResponseBody(null)))
        val repository = AuthRepository(api, ApiResultMapper(json) { session.onUnauthorized() }, session)

        repository.logout()

        assertNull(store.getToken())
        assertEquals(SessionState.LoggedOut, session.state.value)
    }

    @Test
    fun `logout clears the local session on a successful network call`() = runTest {
        val store = InMemoryTokenStore(initial = "existing-token")
        val session = sessionRepo(store)
        val api = FakeMobileApiService(logoutResponse = Response.success(LogoutResponse("Logged out")))
        val repository = AuthRepository(api, ApiResultMapper(json) { session.onUnauthorized() }, session)

        repository.logout()

        assertNull(store.getToken())
        assertEquals(SessionState.LoggedOut, session.state.value)
    }
}
