package com.akvisionflow.owner

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.akvisionflow.owner.core.data.SecureSessionContextStore
import com.akvisionflow.owner.core.data.SecureTokenStore
import com.akvisionflow.owner.core.data.SessionContext
import com.akvisionflow.owner.core.ui.components.CONNECTION_BANNER_TAG
import com.akvisionflow.owner.core.ui.components.ConnectionBanner
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Phase 4.1 tests that need a real Android runtime (Keystore-backed encrypted storage, Compose rendering).
 * They compile with the project (assembleDebugAndroidTest) and run with `./gradlew connectedDebugAndroidTest`
 * on a device or emulator. They were NOT executed in the environment this phase was built in (no device, and
 * hardware virtualization is disabled in its firmware) - see the Phase 4.1 report.
 */
@RunWith(AndroidJUnit4::class)
class Phase41InstrumentedTest {

    @get:Rule
    val compose = createComposeRule()

    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    @After
    fun cleanUp() {
        SecureTokenStore(context).clear()
        SecureSessionContextStore(context).clear()
    }

    @Test
    fun offlineBannerShowsOnlyWhileOffline() {
        val online = false
        compose.setContent { MaterialTheme { ConnectionBanner(isOnline = online) } }
        compose.onNodeWithTag(CONNECTION_BANNER_TAG).assertIsDisplayed()
        compose.onNodeWithText("You are offline", substring = true).assertIsDisplayed()
    }

    @Test
    fun onlineShowsNoBanner() {
        compose.setContent { MaterialTheme { ConnectionBanner(isOnline = true) } }
        compose.onNodeWithTag(CONNECTION_BANNER_TAG).assertDoesNotExist()
    }

    @Test
    fun tokenAndSessionContextSurviveInEncryptedStorageAndAreClearedTogether() {
        val tokens = SecureTokenStore(context)
        val contexts = SecureSessionContextStore(context)
        val ctx = SessionContext("u1", "Mira", "m@s.test", "MANAGER", "Shop", "PKR", setOf("REPORT:VIEW"), false, null)

        tokens.saveToken("tok")
        contexts.save(ctx)

        assertEquals("tok", SecureTokenStore(context).getToken())
        assertEquals(ctx, SecureSessionContextStore(context).get())

        tokens.clear()
        contexts.clear()
        assertNull(SecureTokenStore(context).getToken())
        assertNull(SecureSessionContextStore(context).get())
    }
}

/** Phase 4.3 UI check (compiles with the project; needs a device to run - see the Phase 4.3 report). */
@RunWith(AndroidJUnit4::class)
class Phase43InstrumentedTest {

    @get:Rule
    val compose = createComposeRule()

    private fun ctx(vararg perms: String) = SessionContext("u", "Mira", "m@s.test", "MANAGER", "Shop", "PKR", perms.toSet())

    @Test
    fun hubShowsOnlyTheAreasThePermissionsAllow() {
        compose.setContent { MaterialTheme { com.akvisionflow.owner.feature.manage.ManageHubScreen(context = ctx("CUSTOMER:VIEW", "PURCHASE_ORDER:VIEW"), onOpen = {}) } }
        compose.onNodeWithText("Customers").assertIsDisplayed()
        compose.onNodeWithText("Purchase Orders").assertIsDisplayed()
        compose.onNodeWithText("Sales").assertDoesNotExist()
        compose.onNodeWithText("Stock Transfers").assertDoesNotExist()
    }

    @Test
    fun hubSaysSoWhenNothingIsAllowed() {
        compose.setContent { MaterialTheme { com.akvisionflow.owner.feature.manage.ManageHubScreen(context = ctx("REPORT:VIEW"), onOpen = {}) } }
        compose.onNodeWithText("Your role has no management areas in the app.").assertIsDisplayed()
    }
}
