package com.akvisionflow.owner.core.network

import java.io.IOException
import kotlinx.serialization.json.Json
import retrofit2.Response

/**
 * Turns a raw Retrofit [Response] into the app-wide [ApiResult] shape,
 * parsing the backend's standard `{ error }` error body (see
 * backend/src/middleware/errorHandler.js) and reacting once, centrally, to a
 * 401 by tearing down the local session - callers never have to remember to
 * do this themselves.
 */
class ApiResultMapper(
    private val json: Json,
    private val onUnauthorized: () -> Unit,
) {
    suspend fun <T> execute(call: suspend () -> Response<T>): ApiResult<T> {
        return try {
            val response = call()
            if (response.isSuccessful) {
                val body = response.body()
                if (body != null) {
                    ApiResult.Success(body)
                } else {
                    ApiResult.Error(ApiErrorKind.SERVER, "The server returned an empty response.")
                }
            } else {
                val kind = kindFor(response.code())
                if (kind == ApiErrorKind.UNAUTHORIZED) onUnauthorized()
                val body = parseBody(response)
                ApiResult.Error(kind, body?.error ?: defaultMessageFor(response.code()), body?.code)
            }
        } catch (e: IOException) {
            ApiResult.Error(ApiErrorKind.NETWORK, "Unable to reach BizOS. Check your connection and try again.")
        } catch (e: Exception) {
            ApiResult.Error(ApiErrorKind.SERVER, "Something went wrong. Please try again.")
        }
    }

    private fun kindFor(code: Int): ApiErrorKind = when (code) {
        401 -> ApiErrorKind.UNAUTHORIZED
        403 -> ApiErrorKind.FORBIDDEN
        422 -> ApiErrorKind.VALIDATION
        else -> ApiErrorKind.SERVER
    }

    private fun parseBody(response: Response<*>): ApiErrorBody? {
        val raw = response.errorBody()?.string()
        if (raw.isNullOrBlank()) return null
        return try {
            json.decodeFromString(ApiErrorBody.serializer(), raw)
        } catch (e: Exception) {
            null
        }
    }

    private fun defaultMessageFor(code: Int): String = when (code) {
        401 -> "Your session has expired. Please sign in again."
        403 -> "This action isn't permitted."
        422 -> "That request wasn't valid."
        else -> "Something went wrong. Please try again."
    }
}
