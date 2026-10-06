package com.akvisionflow.owner.core.navigation

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.akvisionflow.owner.core.data.SessionContext
import com.akvisionflow.owner.core.ui.components.ConnectionBanner
import androidx.compose.ui.Modifier
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.akvisionflow.owner.core.AppContainer
import com.akvisionflow.owner.core.ViewModelFactory
import com.akvisionflow.owner.feature.aiadvisor.AiAdvisorScreen
import com.akvisionflow.owner.feature.aiadvisor.AiAdvisorViewModel
import com.akvisionflow.owner.feature.aiadvisor.AiBriefingScreen
import com.akvisionflow.owner.feature.aiadvisor.AiBriefingViewModel
import com.akvisionflow.owner.feature.aiadvisor.AiHistoryScreen
import com.akvisionflow.owner.feature.aiadvisor.AiHistoryViewModel
import com.akvisionflow.owner.feature.aiadvisor.AiInsightDetailScreen
import com.akvisionflow.owner.feature.aiadvisor.AiInsightDetailViewModel
import com.akvisionflow.owner.feature.aiadvisor.AiNeedsAttentionScreen
import com.akvisionflow.owner.feature.aiadvisor.AiNeedsAttentionViewModel
import com.akvisionflow.owner.feature.alerts.AlertsScreen
import com.akvisionflow.owner.feature.alerts.AlertsViewModel
import com.akvisionflow.owner.feature.analytics.AnalyticsScreen
import com.akvisionflow.owner.feature.analytics.AnalyticsViewModel
import com.akvisionflow.owner.feature.home.HomeScreen
import com.akvisionflow.owner.feature.manage.ManageDetailScreen
import com.akvisionflow.owner.feature.manage.ManageDetailViewModel
import com.akvisionflow.owner.feature.manage.ManageHubScreen
import com.akvisionflow.owner.feature.manage.ManageKind
import com.akvisionflow.owner.feature.manage.ManageListScreen
import com.akvisionflow.owner.feature.manage.ManageListViewModel
import com.akvisionflow.owner.feature.manage.visibleKinds
import com.akvisionflow.owner.feature.home.HomeViewModel
import com.akvisionflow.owner.feature.profile.ProfileScreen
import com.akvisionflow.owner.feature.profile.ProfileViewModel

private const val AI_BRIEFING_ROUTE = "ai_advisor/briefing"
private const val AI_NEEDS_ATTENTION_ROUTE = "ai_advisor/needs_attention"
private const val AI_HISTORY_ROUTE = "ai_advisor/history"
private const val AI_INSIGHT_DETAIL_ROUTE = "ai_advisor/insight/{insightId}"
private const val MANAGE_LIST_ROUTE = "manage/list/{kind}"
private const val MANAGE_DETAIL_ROUTE = "manage/detail/{kind}/{id}"

/**
 * Switches bottom-nav tabs while preserving each tab's own back stack/state. A tab the session is not allowed to
 * open (its permission is missing) is never navigated to - the API would refuse its data anyway.
 */
private fun navigateToTab(navController: NavHostController, route: String, allowed: Set<String>) {
    if (route !in allowed) return
    navController.navigate(route) {
        popUpTo(navController.graph.findStartDestination().id) { saveState = true }
        launchSingleTop = true
        restoreState = true
    }
}

/** Maps an alert's/AI insight's backend-supplied `deepLink` value to a bottom-nav tab (see alertMapping.js on the backend). */
private fun routeForDeepLink(deepLink: String): String = when (deepLink) {
    "home" -> MainDestination.HOME.route
    "analytics" -> MainDestination.ANALYTICS.route
    "ai_advisor" -> MainDestination.AI_ADVISOR.route
    else -> MainDestination.ANALYTICS.route
}

/** The main authenticated app shell: bottom navigation across the five Phase 1 sections. */
@Composable
fun MainScaffold(container: AppContainer) {
    val navController: NavHostController = rememberNavController()
    val sessionContext: SessionContext? by container.sessionRepository.context.collectAsStateWithLifecycle()
    val online by container.connectivityMonitor.isOnline.collectAsStateWithLifecycle()
    val reconnects by container.connectivityMonitor.reconnects.collectAsStateWithLifecycle()
    val visible = visibleDestinations(sessionContext)
    val allowedRoutes = visible.map { it.route }.toSet()
    val start = remember { startDestination(sessionContext) }

    // If the server takes an access away while the app is open (a role or a grant changed), leave a tab that is no longer allowed.
    val current = navController.currentBackStackEntryAsState().value?.destination?.route
    LaunchedEffect(allowedRoutes, current) {
        val isTab = MainDestination.entries.any { it.route == current }
        if (isTab && current !in allowedRoutes) navigateToTab(navController, visible.first().route, allowedRoutes)
    }

    Scaffold(
        bottomBar = { OwnerBottomBar(navController, visible, allowedRoutes) },
    ) { padding ->
        Column(modifier = Modifier.padding(padding)) {
        ConnectionBanner(isOnline = online)
        NavHost(
            navController = navController,
            startDestination = start.route,
        ) {
            composable(MainDestination.HOME.route) {
                val viewModel: HomeViewModel = viewModel(factory = ViewModelFactory(container))
                HomeScreen(
                    viewModel = viewModel,
                    onOpenAnalytics = { navigateToTab(navController, MainDestination.ANALYTICS.route, allowedRoutes) },
                    onOpenAlerts = { navigateToTab(navController, MainDestination.ALERTS.route, allowedRoutes) },
                    reconnectCount = reconnects,
                )
            }
            composable(MainDestination.ANALYTICS.route) {
                val viewModel: AnalyticsViewModel = viewModel(factory = ViewModelFactory(container))
                AnalyticsScreen(viewModel = viewModel)
            }
            composable(MainDestination.ALERTS.route) {
                val viewModel: AlertsViewModel = viewModel(factory = ViewModelFactory(container))
                AlertsScreen(
                    viewModel = viewModel,
                    onNavigateToDeepLink = { deepLink -> navigateToTab(navController, routeForDeepLink(deepLink), allowedRoutes) },
                )
            }
            composable(MainDestination.AI_ADVISOR.route) {
                val viewModel: AiAdvisorViewModel = viewModel(factory = ViewModelFactory(container))
                AiAdvisorScreen(
                    viewModel = viewModel,
                    onOpenBriefing = { navController.navigate(AI_BRIEFING_ROUTE) },
                    onOpenNeedsAttention = { navController.navigate(AI_NEEDS_ATTENTION_ROUTE) },
                    onOpenHistory = { navController.navigate(AI_HISTORY_ROUTE) },
                    onOpenInsight = { id -> navController.navigate("ai_advisor/insight/$id") },
                )
            }
            composable(AI_BRIEFING_ROUTE) {
                val viewModel: AiBriefingViewModel = viewModel(factory = ViewModelFactory(container))
                AiBriefingScreen(viewModel = viewModel)
            }
            composable(AI_NEEDS_ATTENTION_ROUTE) {
                val viewModel: AiNeedsAttentionViewModel = viewModel(factory = ViewModelFactory(container))
                AiNeedsAttentionScreen(
                    viewModel = viewModel,
                    onOpenInsight = { id -> navController.navigate("ai_advisor/insight/$id") },
                )
            }
            composable(AI_HISTORY_ROUTE) {
                val viewModel: AiHistoryViewModel = viewModel(factory = ViewModelFactory(container))
                AiHistoryScreen(
                    viewModel = viewModel,
                    onOpenInsight = { id -> navController.navigate("ai_advisor/insight/$id") },
                )
            }
            composable(
                AI_INSIGHT_DETAIL_ROUTE,
                arguments = listOf(navArgument("insightId") { type = NavType.StringType }),
            ) { backStackEntry ->
                val insightId = backStackEntry.arguments?.getString("insightId").orEmpty()
                val viewModel: AiInsightDetailViewModel = viewModel(
                    factory = object : ViewModelProvider.Factory {
                        @Suppress("UNCHECKED_CAST")
                        override fun <T : ViewModel> create(modelClass: Class<T>): T =
                            AiInsightDetailViewModel(container.aiAdvisorRepository, container.alertsRepository, insightId) as T
                    },
                )
                AiInsightDetailScreen(viewModel = viewModel)
            }
            // Phase 4.3: management areas. A kind the session may not open is never shown - and if one is reached anyway
            // (a permission withdrawn while the screen was open) the screen closes; the API refuses it regardless.
            composable(MainDestination.MANAGE.route) {
                ManageHubScreen(context = sessionContext, onOpen = { kind -> navController.navigate("manage/list/${kind.name}") })
            }
            composable(MANAGE_LIST_ROUTE, arguments = listOf(navArgument("kind") { type = NavType.StringType })) { entry ->
                val kind = entry.arguments?.getString("kind")?.let { name -> ManageKind.entries.firstOrNull { it.name == name } }
                if (kind == null || kind !in visibleKinds(sessionContext)) {
                    LaunchedEffect(Unit) { navController.popBackStack() }
                } else {
                    val viewModel: ManageListViewModel = viewModel(
                        key = "manage-list-${kind.name}",
                        factory = object : ViewModelProvider.Factory {
                            @Suppress("UNCHECKED_CAST")
                            override fun <T : ViewModel> create(modelClass: Class<T>): T = ManageListViewModel(kind, container.manageRepository) as T
                        },
                    )
                    ManageListScreen(kind, viewModel, onOpen = { id -> navController.navigate("manage/detail/${kind.name}/$id") }, onBack = { navController.popBackStack() })
                }
            }
            composable(MANAGE_DETAIL_ROUTE, arguments = listOf(navArgument("kind") { type = NavType.StringType }, navArgument("id") { type = NavType.StringType })) { entry ->
                val kind = entry.arguments?.getString("kind")?.let { name -> ManageKind.entries.firstOrNull { it.name == name } }
                val id = entry.arguments?.getString("id").orEmpty()
                if (kind == null || kind !in visibleKinds(sessionContext)) {
                    LaunchedEffect(Unit) { navController.popBackStack() }
                } else {
                    val viewModel: ManageDetailViewModel = viewModel(
                        key = "manage-detail-${kind.name}-$id",
                        factory = object : ViewModelProvider.Factory {
                            @Suppress("UNCHECKED_CAST")
                            override fun <T : ViewModel> create(modelClass: Class<T>): T = ManageDetailViewModel(kind, id, container.manageRepository) as T
                        },
                    )
                    ManageDetailScreen(kind, viewModel, sessionContext, online, onBack = { navController.popBackStack() })
                }
            }
            composable(MainDestination.PROFILE.route) {
                val viewModel: ProfileViewModel = viewModel(factory = ViewModelFactory(container))
                ProfileScreen(viewModel = viewModel)
            }
        }
        }
    }
}

@Composable
private fun OwnerBottomBar(navController: NavHostController, destinations: List<MainDestination>, allowedRoutes: Set<String>) {
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route

    NavigationBar {
        destinations.forEach { destination ->
            NavigationBarItem(
                selected = currentRoute == destination.route,
                onClick = { navigateToTab(navController, destination.route, allowedRoutes) },
                icon = { Icon(destination.icon, contentDescription = destination.label) },
                label = { Text(destination.label) },
            )
        }
    }
}
