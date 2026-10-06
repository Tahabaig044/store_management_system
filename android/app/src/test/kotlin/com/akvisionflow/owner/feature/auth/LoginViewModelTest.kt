package com.akvisionflow.owner.feature.auth

import com.akvisionflow.owner.core.data.FakeDeviceIdProvider
import com.akvisionflow.owner.core.data.InMemoryTokenStore
import com.akvisionflow.owner.core.data.SessionRepository
import com.akvisionflow.owner.core.network.ApiResultMapper
import com.akvisionflow.owner.core.network.dto.DeviceTokenSummary
import com.akvisionflow.owner.core.network.dto.LoginResponse
import com.akvisionflow.owner.core.network.dto.OwnerUserDto
import com.akvisionflow.owner.core.network.dto.PermissionsDto
import com.akvisionflow.owner.core.network.dto.RegisterDeviceResponse
import com.akvisionflow.owner.core.network.dto.TenantSummaryDto
import com.akvisionflow.owner.feature.alerts.AlertsRepository
import com.akvisionflow.owner.testutil.FakeAlertsApiService
import com.akvisionflow.owner.testutil.FakeMobileApiService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import retrofit2.Response

@OptIn(ExperimentalCoroutinesApi::class)
class LoginViewModelTest {

    private val dispatcher = StandardTestDispatcher()
    private val json = Json { ignoreUnknownKeys = true }

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun buildRepository(api: FakeMobileApiService): AuthRepository {
        val session = SessionRepository(InMemoryTokenStore())
        val mapper = ApiResultMapper(json) { session.onUnauthorized() }
        return AuthRepository(api, mapper, session)
    }

    private fun buildAlertsRepository(): AlertsRepository {
        val alertsApi = FakeAlertsApiService(
            registerResponse = Response.success(RegisterDeviceResponse(DeviceTokenSummary("d1", "ANDROID", true))),
        )
        return AlertsRepository(alertsApi, ApiResultMapper(json) {}, FakeDeviceIdProvider())
    }

    @Test
    fun `submit with blank fields shows an error without calling the API`() = runTest {
        val api = FakeMobileApiService()
        val viewModel = LoginViewModel(buildRepository(api), buildAlertsRepository())

        viewModel.submit()

        assertEquals(0, api.loginCallCount)
        assertTrue(viewModel.uiState.value.errorMessage != null)
    }

    @Test
    fun `successful submit sets loginSucceeded and clears loading`() = runTest {
        val loginResponse = LoginResponse(
            token = "jwt",
            user = OwnerUserDto("u1", "Owner", "owner@test.local", "TENANT_ADMIN"),
            tenant = TenantSummaryDto("t1", "Shop", "Shop Business", null, "USD", "UTC"),
            permissions = PermissionsDto(readOnly = true, role = "OWNER_MOBILE"),
        )
        val api = FakeMobileApiService(loginResponse = Response.success(loginResponse))
        val viewModel = LoginViewModel(buildRepository(api), buildAlertsRepository())

        viewModel.onEmailChange("owner@test.local")
        viewModel.onPasswordChange("password123")
        viewModel.submit()
        dispatcher.scheduler.advanceUntilIdle()

        val state = viewModel.uiState.value
        assertTrue(state.loginSucceeded)
        assertFalse(state.isLoading)
        assertNull(state.errorMessage)
    }

    @Test
    fun `failed submit surfaces the backend's error message`() = runTest {
        val api = FakeMobileApiService(
            loginResponse = Response.error(
                401,
                """{"error":"Invalid email or password"}""".toResponseBody("application/json".toMediaType()),
            ),
        )
        val viewModel = LoginViewModel(buildRepository(api), buildAlertsRepository())

        viewModel.onEmailChange("owner@test.local")
        viewModel.onPasswordChange("wrong")
        viewModel.submit()
        dispatcher.scheduler.advanceUntilIdle()

        val state = viewModel.uiState.value
        assertFalse(state.loginSucceeded)
        assertFalse(state.isLoading)
        assertEquals("Invalid email or password", state.errorMessage)
    }
}
