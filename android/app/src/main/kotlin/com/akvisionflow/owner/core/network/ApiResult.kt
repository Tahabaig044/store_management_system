package com.akvisionflow.owner.core.network

/**
 * Uniform outcome type for every mobile API call. The Android app never
 * inspects raw HTTP status codes outside this layer - every repository maps
 * a network/API outcome into one of these before it reaches a ViewModel,
 * so UI code only ever has to handle three cases.
 */
sealed class ApiResult<out T> {
    data class Success<T>(val data: T) : ApiResult<T>()
    /** [code] is the backend's stable machine-readable code (e.g. BRANCH_REQUIRED), when it sent one. */
    data class Error(val kind: ApiErrorKind, val message: String, val code: String? = null) : ApiResult<Nothing>()
}

enum class ApiErrorKind {
    /** No/invalid Bearer token, or the backend rejected it (401). Caller should route to login. */
    UNAUTHORIZED,

    /** Authenticated but not permitted (403) - e.g. the read-only guard rejected a write. */
    FORBIDDEN,

    /** Request was well-formed but rejected by the backend (422) - validation error. */
    VALIDATION,

    /** No connectivity, DNS failure, timeout, or the backend is unreachable. */
    NETWORK,

    /** Any other non-2xx response (5xx, unexpected 4xx) or unparseable body. */
    SERVER,
}

/**
 * Standard error body shape returned by the backend's errorHandler.js:
 * { error, details? }. `details` (zod validation output) isn't surfaced by
 * any Phase 1 screen - there are no write forms - so it's intentionally not
 * modeled here; only the human-readable `error` message is needed.
 */
@kotlinx.serialization.Serializable
data class ApiErrorBody(val error: String? = null, val code: String? = null)
