package com.akvisionflow.owner.core.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed class SessionState {
    data object Authenticated : SessionState()
    data object LoggedOut : SessionState()
}

/**
 * Single source of truth for "is there a valid Owner Mobile session right
 * now", and (Phase 4.1) for who that session is and what it may do.
 *
 * The navigation graph observes [state] to decide between the login flow and
 * the main app shell; [ApiResultMapper] calls [onUnauthorized] the moment any
 * request comes back 401, so an expired/invalidated token drops the user back
 * to login immediately rather than on next manual action.
 *
 * Ending a session - by sign-out OR by a 401 - runs every registered
 * session-ended listener exactly once, so nothing that belongs to the previous
 * user (cached responses, cached profile, filter selections, branch context)
 * can survive into the next sign-in on the same device.
 */
class SessionRepository(
    private val tokenStore: TokenStore,
    private val contextStore: SessionContextStore = InMemorySessionContextStore(),
) {

    private val _state = MutableStateFlow(
        if (tokenStore.getToken() != null) SessionState.Authenticated else SessionState.LoggedOut
    )
    val state: StateFlow<SessionState> = _state.asStateFlow()

    // A stored context only means something next to a stored token; without one it is stale and is dropped.
    private val _context = MutableStateFlow(
        if (tokenStore.getToken() != null) contextStore.get() else null.also { contextStore.clear() }
    )
    val context: StateFlow<SessionContext?> = _context.asStateFlow()

    private val endedListeners = mutableListOf<() -> Unit>()

    fun addSessionEndedListener(listener: () -> Unit) {
        endedListeners += listener
    }

    fun onLoginSuccess(token: String, sessionContext: SessionContext? = null) {
        tokenStore.saveToken(token)
        if (sessionContext != null) contextStore.save(sessionContext) else contextStore.clear()
        _context.value = sessionContext
        _state.value = SessionState.Authenticated
    }

    /** The server reported this session's current access (e.g. a role or a grant changed): keep it, and persist it. */
    fun updateContext(sessionContext: SessionContext) {
        if (_state.value !is SessionState.Authenticated || _context.value == sessionContext) return
        contextStore.save(sessionContext)
        _context.value = sessionContext
    }

    fun onLogout() {
        val wasAuthenticated = _state.value is SessionState.Authenticated
        tokenStore.clear()
        contextStore.clear()
        _context.value = null
        _state.value = SessionState.LoggedOut
        if (wasAuthenticated) endedListeners.toList().forEach { runCatching(it) }
    }

    fun onUnauthorized() {
        if (_state.value is SessionState.Authenticated) {
            onLogout()
        }
    }
}
