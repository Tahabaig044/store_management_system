package com.akvisionflow.owner.core.data

import com.akvisionflow.owner.core.network.dto.AccessDto
import com.akvisionflow.owner.core.network.dto.LoginResponse
import com.akvisionflow.owner.core.network.dto.ProfileResponse
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * Who is signed in and what they may do - the non-secret half of a session (the token is the secret half).
 *
 * Everything here is a UX convenience: the app hides what the user cannot do so they are not offered dead
 * ends. It is never the authority - the backend re-checks the role, the permission and the branch scope on every
 * request, so a tampered copy of this object can hide or show a button but can never grant access to data.
 * [permissions] are the backend's own catalog keys ("RESOURCE:ACTION"), the same ones the web app uses.
 */
@Serializable
data class SessionContext(
    val userId: String,
    val name: String,
    val email: String,
    val role: String,
    val businessName: String,
    val currency: String,
    val permissions: Set<String> = emptySet(),
    val branchRestricted: Boolean = false,
    val branchIds: List<String>? = null,
) {
    fun can(permission: String): Boolean = permission in permissions
    fun canAny(vararg keys: String): Boolean = keys.any { it in permissions }

    /** The same session after the server reported its current access (role or grants may have changed). */
    fun withAccess(access: AccessDto): SessionContext = copy(
        role = access.role,
        permissions = access.permissions.toSet(),
        branchRestricted = access.branchRestricted,
        branchIds = access.branchIds,
    )

    companion object {
        /** A pre-4.1 server sends no `access`: such a session is given NO permissions rather than assumed ones. */
        fun from(response: LoginResponse): SessionContext = SessionContext(
            userId = response.user.id,
            name = response.user.name,
            email = response.user.email,
            role = response.access?.role ?: response.user.role,
            businessName = response.tenant.businessName,
            currency = response.tenant.currency,
            permissions = response.access?.permissions?.toSet() ?: emptySet(),
            branchRestricted = response.access?.branchRestricted ?: false,
            branchIds = response.access?.branchIds,
        )
    }
}

/** Where the [SessionContext] is kept between launches. The real one is encrypted; tests use the in-memory one. */
interface SessionContextStore {
    fun get(): SessionContext?
    fun save(context: SessionContext)
    fun clear()
}

class InMemorySessionContextStore(initial: SessionContext? = null) : SessionContextStore {
    private var value: SessionContext? = initial
    override fun get(): SessionContext? = value
    override fun save(context: SessionContext) { value = context }
    override fun clear() { value = null }
}

private val contextJson = Json { ignoreUnknownKeys = true }

fun SessionContext.toJson(): String = contextJson.encodeToString(this)

/** A stored value that no longer parses (older app version, corruption) is treated as "no context", never a crash. */
fun sessionContextFromJson(raw: String?): SessionContext? =
    if (raw.isNullOrBlank()) null else runCatching { contextJson.decodeFromString<SessionContext>(raw) }.getOrNull()

/** Convenience for refreshing from a profile response. */
fun SessionContext.refreshedFrom(profile: ProfileResponse): SessionContext = profile.access?.let { withAccess(it) } ?: this
