package com.akvisionflow.owner.core.connectivity

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectivityStateTest {

    @Test
    fun `starts with what the device reports`() {
        assertTrue(ConnectivityState(true).isOnline.value)
        assertFalse(ConnectivityState(false).isOnline.value)
    }

    @Test
    fun `losing and regaining the connection counts one reconnect - staying online counts none`() {
        val s = ConnectivityState(true)
        s.set(true)
        assertEquals(0, s.reconnects.value)
        s.set(false)
        assertFalse(s.isOnline.value)
        assertEquals(0, s.reconnects.value)
        s.set(true)
        assertTrue(s.isOnline.value)
        assertEquals(1, s.reconnects.value)
        s.set(true)
        assertEquals(1, s.reconnects.value)
    }

    @Test
    fun `a flapping connection counts every return`() {
        val s = ConnectivityState(false)
        repeat(3) { s.set(true); s.set(false) }
        assertEquals(3, s.reconnects.value)
    }
}
