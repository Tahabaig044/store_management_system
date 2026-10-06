package com.akvisionflow.owner.core.navigation

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Analytics
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.ui.graphics.vector.ImageVector
import com.akvisionflow.owner.core.data.SessionContext

const val LOGIN_ROUTE = "login"
const val MAIN_ROUTE = "main"

/**
 * The bottom-navigation destinations. [requiredPermission] is the backend catalog key the screen's data needs
 * (the same one the API enforces): a session without it is not offered the tab. This only avoids dead ends -
 * the API refuses the request regardless of what the app shows.
 */
enum class MainDestination(
    val route: String,
    val label: String,
    val icon: ImageVector,
    val requiredPermission: String? = null,
    /** Offered when the session holds ANY of these (e.g. Manage: any of its areas' view permissions). */
    val requiredAny: List<String> = emptyList(),
) {
    HOME("home", "Home", Icons.Filled.Home, "REPORT:VIEW"),
    ANALYTICS("analytics", "Analytics", Icons.Filled.Analytics, "REPORT:VIEW"),
    MANAGE("manage", "Manage", Icons.Filled.Inventory2, requiredAny = com.akvisionflow.owner.feature.manage.ManageKind.entries.map { it.viewPermission }),
    ALERTS("alerts", "Alerts", Icons.Filled.Notifications, "REPORT:VIEW"),
    AI_ADVISOR("ai_advisor", "AI Advisor", Icons.Filled.Psychology, "REPORT:VIEW"),
    PROFILE("profile", "Profile", Icons.Filled.Person),
}

/** The destinations this session may open, in tab order. Profile (the session itself) is always available. */
fun visibleDestinations(context: SessionContext?): List<MainDestination> =
    MainDestination.entries.filter { d ->
        when {
            d.requiredAny.isNotEmpty() -> d.requiredAny.any { context?.can(it) == true }
            d.requiredPermission != null -> context?.can(d.requiredPermission) == true
            else -> true
        }
    }

/** Where the app opens: the first permitted tab (Home for a management user, Profile if nothing else is allowed). */
fun startDestination(context: SessionContext?): MainDestination = visibleDestinations(context).first()
