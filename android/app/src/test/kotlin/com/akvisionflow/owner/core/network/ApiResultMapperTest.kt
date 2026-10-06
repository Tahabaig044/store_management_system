package com.akvisionflow.owner.core.network

import java.io.IOException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

class ApiResultMapperTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun mapper(onUnauthorized: () -> Unit = {}) = ApiResultMapper(json, onUnauthorized)

    @Test
    fun `success response is unwrapped`() = runTest {
        val result = mapper().execute { Response.success("ok") }
        assertEquals(ApiResult.Success("ok"), result)
    }

    @Test
    fun `401 maps to UNAUTHORIZED and triggers the callback exactly once`() = runTest {
        var callCount = 0
        val body = """{"error":"Invalid or expired token"}""".toResponseBody("application/json".toMediaType())
        val result = mapper(onUnauthorized = { callCount++ }).execute { Response.error<String>(401, body) }

        assertTrue(result is ApiResult.Error)
        result as ApiResult.Error
        assertEquals(ApiErrorKind.UNAUTHORIZED, result.kind)
        assertEquals("Invalid or expired token", result.message)
        assertEquals(1, callCount)
    }

    @Test
    fun `403 maps to FORBIDDEN and does not trigger the unauthorized callback`() = runTest {
        var callCount = 0
        val body = """{"error":"The Owner Mobile app is read-only; this action is not permitted"}"""
            .toResponseBody("application/json".toMediaType())
        val result = mapper(onUnauthorized = { callCount++ }).execute { Response.error<String>(403, body) }

        assertTrue(result is ApiResult.Error)
        assertEquals(ApiErrorKind.FORBIDDEN, (result as ApiResult.Error).kind)
        assertEquals(0, callCount)
    }

    @Test
    fun `422 maps to VALIDATION`() = runTest {
        val body = """{"error":"Invalid login data"}""".toResponseBody("application/json".toMediaType())
        val result = mapper().execute { Response.error<String>(422, body) }
        assertEquals(ApiErrorKind.VALIDATION, (result as ApiResult.Error).kind)
    }

    @Test
    fun `unparseable error body falls back to a default message instead of crashing`() = runTest {
        val body = "not json".toResponseBody("text/plain".toMediaType())
        val result = mapper().execute { Response.error<String>(500, body) }
        assertTrue(result is ApiResult.Error)
        assertEquals(ApiErrorKind.SERVER, (result as ApiResult.Error).kind)
        assertTrue(result.message.isNotBlank())
    }

    @Test
    fun `network failure maps to NETWORK`() = runTest {
        val result = mapper().execute<String> { throw IOException("no route to host") }
        assertEquals(ApiErrorKind.NETWORK, (result as ApiResult.Error).kind)
    }
}
