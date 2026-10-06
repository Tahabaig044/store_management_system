package com.akvisionflow.owner.core.navigation

import com.akvisionflow.owner.core.data.SessionContext
import org.junit.Assert.assertEquals
import org.junit.Test

class DestinationsTest {

    private fun ctx(vararg perms: String) = SessionContext("u", "N", "e@x.test", "MANAGER", "Shop", "PKR", perms.toSet())

    @Test
    fun `a session with report access sees every tab, starting at Home`() {
        val c = ctx("REPORT:VIEW")
        // Manage appears only when the session may view at least one management area.
        assertEquals(MainDestination.entries.filter { it != MainDestination.MANAGE }, visibleDestinations(c))
        assertEquals(MainDestination.entries.toList(), visibleDestinations(ctx("REPORT:VIEW", "CUSTOMER:VIEW")))
        assertEquals(MainDestination.HOME, startDestination(c))
    }

    @Test
    fun `without report access only the Profile tab remains, and it is where the app opens`() {
        val c = ctx("USER:VIEW")
        assertEquals(listOf(MainDestination.PROFILE), visibleDestinations(c))
        assertEquals(MainDestination.PROFILE, startDestination(c))
    }

    @Test
    fun `no context at all (not signed in yet) shows nothing but Profile - never more than the session proves`() {
        assertEquals(listOf(MainDestination.PROFILE), visibleDestinations(null))
    }
}
