package com.akvisionflow.owner.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionLifecycleTest {

    private fun ctx(role: String = "MANAGER", vararg perms: String) = SessionContext("u1", "Mira", "m@s.test", role, "Shop", "PKR", perms.toSet())

    @Test
    fun `signing in stores the context next to the token, and a restart restores both`() {
        val tokens = InMemoryTokenStore()
        val contexts = InMemorySessionContextStore()
        SessionRepository(tokens, contexts).onLoginSuccess("tok", ctx(perms = arrayOf("REPORT:VIEW")))

        val restarted = SessionRepository(tokens, contexts)
        assertEquals(SessionState.Authenticated, restarted.state.value)
        assertTrue(restarted.context.value!!.can("REPORT:VIEW"))
    }

    @Test
    fun `a stored context with no token is stale and is dropped`() {
        val contexts = InMemorySessionContextStore(ctx())
        val repo = SessionRepository(InMemoryTokenStore(), contexts)
        assertNull(repo.context.value)
        assertNull(contexts.get())
    }

    @Test
    fun `signing out clears token and context and runs the session-ended listeners exactly once`() {
        val tokens = InMemoryTokenStore()
        val contexts = InMemorySessionContextStore()
        val repo = SessionRepository(tokens, contexts)
        repo.onLoginSuccess("tok", ctx())
        var ended = 0
        repo.addSessionEndedListener { ended++ }

        repo.onLogout()
        repo.onLogout() // a second sign-out is not a second end

        assertEquals(1, ended)
        assertNull(tokens.getToken())
        assertNull(contexts.get())
        assertNull(repo.context.value)
        assertEquals(SessionState.LoggedOut, repo.state.value)
    }

    @Test
    fun `a 401 ends the session the same way as signing out - nothing of the user is left behind`() {
        val repo = SessionRepository(InMemoryTokenStore(), InMemorySessionContextStore())
        repo.onLoginSuccess("tok", ctx())
        var ended = 0
        repo.addSessionEndedListener { ended++ }

        repo.onUnauthorized()
        repo.onUnauthorized() // further 401s from in-flight requests change nothing

        assertEquals(1, ended)
        assertNull(repo.context.value)
    }

    @Test
    fun `a failing listener cannot stop the others or the sign-out itself`() {
        val repo = SessionRepository(InMemoryTokenStore(), InMemorySessionContextStore())
        repo.onLoginSuccess("tok", ctx())
        var second = false
        repo.addSessionEndedListener { error("boom") }
        repo.addSessionEndedListener { second = true }
        repo.onLogout()
        assertTrue(second)
        assertEquals(SessionState.LoggedOut, repo.state.value)
    }

    @Test
    fun `a context update (the server changed the access) is kept and persisted, but not after sign-out`() {
        val contexts = InMemorySessionContextStore()
        val repo = SessionRepository(InMemoryTokenStore(), contexts)
        repo.onLoginSuccess("tok", ctx(perms = arrayOf("REPORT:VIEW")))
        repo.updateContext(ctx(perms = emptyArray()))
        assertTrue(repo.context.value!!.permissions.isEmpty())
        assertTrue(contexts.get()!!.permissions.isEmpty())

        repo.onLogout()
        repo.updateContext(ctx(perms = arrayOf("REPORT:VIEW"))) // a late response arriving after sign-out
        assertNull(repo.context.value)
        assertNull(contexts.get())
    }
}
