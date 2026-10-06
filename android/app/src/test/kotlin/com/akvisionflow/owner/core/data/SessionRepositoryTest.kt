package com.akvisionflow.owner.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionRepositoryTest {

    @Test
    fun `starts Authenticated when a token is already stored`() {
        val store = InMemoryTokenStore(initial = "existing-token")
        val repo = SessionRepository(store)
        assertEquals(SessionState.Authenticated, repo.state.value)
    }

    @Test
    fun `starts LoggedOut when no token is stored`() {
        val repo = SessionRepository(InMemoryTokenStore())
        assertEquals(SessionState.LoggedOut, repo.state.value)
    }

    @Test
    fun `onLoginSuccess saves the token and flips to Authenticated`() {
        val store = InMemoryTokenStore()
        val repo = SessionRepository(store)

        repo.onLoginSuccess("new-token")

        assertEquals("new-token", store.getToken())
        assertEquals(SessionState.Authenticated, repo.state.value)
    }

    @Test
    fun `onLogout clears the token and flips to LoggedOut`() {
        val store = InMemoryTokenStore(initial = "token")
        val repo = SessionRepository(store)

        repo.onLogout()

        assertNull(store.getToken())
        assertEquals(SessionState.LoggedOut, repo.state.value)
    }

    @Test
    fun `onUnauthorized behaves like onLogout when currently authenticated`() {
        val store = InMemoryTokenStore(initial = "token")
        val repo = SessionRepository(store)

        repo.onUnauthorized()

        assertNull(store.getToken())
        assertEquals(SessionState.LoggedOut, repo.state.value)
    }

    @Test
    fun `onUnauthorized is a no-op when already logged out`() {
        val repo = SessionRepository(InMemoryTokenStore())
        repo.onUnauthorized()
        assertEquals(SessionState.LoggedOut, repo.state.value)
    }
}
