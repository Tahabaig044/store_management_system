package com.akvisionflow.owner.core

import android.content.Context
import com.akvisionflow.owner.core.data.AndroidDeviceIdProvider
import com.akvisionflow.owner.core.data.DeviceIdProvider
import com.akvisionflow.owner.core.connectivity.AndroidConnectivityMonitor
import com.akvisionflow.owner.core.connectivity.ConnectivityMonitor
import com.akvisionflow.owner.core.context.BranchContextRepository
import com.akvisionflow.owner.core.data.DashboardSnapshotStore
import com.akvisionflow.owner.core.data.SecureDashboardSnapshotStore
import com.akvisionflow.owner.core.data.SecureSessionContextStore
import com.akvisionflow.owner.core.data.SecureTokenStore
import com.akvisionflow.owner.core.data.SessionRepository
import com.akvisionflow.owner.core.data.SessionState
import com.akvisionflow.owner.core.data.TokenStore
import com.akvisionflow.owner.core.filters.DashboardFilterRepository
import com.akvisionflow.owner.core.network.AiAdvisorApiService
import com.akvisionflow.owner.core.network.AlertsApiService
import com.akvisionflow.owner.core.network.ApiResultMapper
import com.akvisionflow.owner.core.network.DashboardApiService
import com.akvisionflow.owner.core.network.ManageApiService
import com.akvisionflow.owner.core.network.MobileApiService
import com.akvisionflow.owner.core.network.NetworkModule
import com.akvisionflow.owner.feature.aiadvisor.AiAdvisorRepository
import com.akvisionflow.owner.feature.alerts.AlertsRepository
import com.akvisionflow.owner.feature.auth.AuthRepository
import com.akvisionflow.owner.feature.dashboard.DashboardRepository
import com.akvisionflow.owner.feature.manage.ManageRepository
import com.akvisionflow.owner.feature.profile.ProfileRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Hand-rolled composition root. Phase 1 has a small, fixed dependency graph
 * (one API surface, one token store, a handful of repositories), so a full
 * DI framework isn't justified yet - this single object wires everything
 * once at process start and hands out the pieces each ViewModel needs.
 */
class AppContainer(context: Context) {

    val tokenStore: TokenStore = SecureTokenStore(context)
    val sessionRepository = SessionRepository(tokenStore, SecureSessionContextStore(context))
    val dashboardFilterRepository = DashboardFilterRepository()
    val dashboardSnapshotStore: DashboardSnapshotStore = SecureDashboardSnapshotStore(context)
    val connectivityMonitor: ConnectivityMonitor = AndroidConnectivityMonitor(context)
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val deviceIdProvider: DeviceIdProvider = AndroidDeviceIdProvider(context)

    private val apiService: MobileApiService
    private val dashboardApiService: DashboardApiService
    private val alertsApiService: AlertsApiService
    private val aiAdvisorApiService: AiAdvisorApiService
    private val resultMapper: ApiResultMapper

    val authRepository: AuthRepository
    val profileRepository: ProfileRepository
    val dashboardRepository: DashboardRepository
    val alertsRepository: AlertsRepository
    val manageRepository: ManageRepository
    val branchContextRepository: BranchContextRepository
    val aiAdvisorRepository: AiAdvisorRepository

    init {
        val okHttpClient = NetworkModule.provideOkHttpClient(context, tokenStore)
        apiService = NetworkModule.provideApiService(okHttpClient)
        dashboardApiService = NetworkModule.provideDashboardApiService(okHttpClient)
        alertsApiService = NetworkModule.provideAlertsApiService(okHttpClient)
        aiAdvisorApiService = NetworkModule.provideAiAdvisorApiService(okHttpClient)
        resultMapper = NetworkModule.provideResultMapper(sessionRepository)

        branchContextRepository = BranchContextRepository(apiService, resultMapper, dashboardFilterRepository)
        authRepository = AuthRepository(apiService, resultMapper, sessionRepository) { branchContextRepository.load() }
        profileRepository = ProfileRepository(apiService, resultMapper, sessionRepository)
        dashboardRepository = DashboardRepository(dashboardApiService, resultMapper)
        alertsRepository = AlertsRepository(alertsApiService, resultMapper, deviceIdProvider)
        aiAdvisorRepository = AiAdvisorRepository(aiAdvisorApiService, resultMapper)
        manageRepository = ManageRepository(NetworkModule.provideManageApiService(okHttpClient), resultMapper) { sessionRepository.context.value?.currency }

        // Whatever a session leaves behind must not reach the next one on this device: the cached responses on
        // disk, the cached profile, the dashboard filter selection and the branch context.
        sessionRepository.addSessionEndedListener {
            dashboardFilterRepository.reset()
            branchContextRepository.clear()
            profileRepository.clearCache()
            appScope.launch { runCatching { dashboardSnapshotStore.clear() } }
            appScope.launch { runCatching { okHttpClient.cache?.evictAll() } }
        }

        // A signed-in app that has been offline re-validates its session the moment the connection returns: a
        // deactivated user, a changed role or a changed branch scope is noticed at once (a 401 signs out).
        appScope.launch {
            var last = connectivityMonitor.reconnects.value
            connectivityMonitor.reconnects.collect { count ->
                if (count != last && sessionRepository.state.value is SessionState.Authenticated) {
                    profileRepository.getProfile(forceRefresh = true)
                    branchContextRepository.load()
                }
                last = count
            }
        }
    }
}
