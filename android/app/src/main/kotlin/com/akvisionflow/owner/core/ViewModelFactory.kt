package com.akvisionflow.owner.core

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import com.akvisionflow.owner.feature.aiadvisor.AiAdvisorViewModel
import com.akvisionflow.owner.feature.aiadvisor.AiBriefingViewModel
import com.akvisionflow.owner.feature.aiadvisor.AiHistoryViewModel
import com.akvisionflow.owner.feature.aiadvisor.AiNeedsAttentionViewModel
import com.akvisionflow.owner.feature.alerts.AlertsViewModel
import com.akvisionflow.owner.feature.analytics.AnalyticsViewModel
import com.akvisionflow.owner.feature.auth.LoginViewModel
import com.akvisionflow.owner.feature.home.HomeViewModel
import com.akvisionflow.owner.feature.profile.ProfileViewModel

/** Simple factory wiring [AppContainer]'s repositories into each screen's ViewModel. */
class ViewModelFactory(private val container: AppContainer) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = when (modelClass) {
        LoginViewModel::class.java -> LoginViewModel(container.authRepository, container.alertsRepository) as T
        ProfileViewModel::class.java -> ProfileViewModel(container.profileRepository, container.authRepository, container.alertsRepository) as T
        HomeViewModel::class.java -> HomeViewModel(container.dashboardRepository, container.dashboardFilterRepository, container.profileRepository, container.dashboardSnapshotStore, container.alertsRepository) as T
        AnalyticsViewModel::class.java -> AnalyticsViewModel(container.dashboardRepository, container.dashboardFilterRepository) as T
        AlertsViewModel::class.java -> AlertsViewModel(container.alertsRepository) as T
        AiAdvisorViewModel::class.java -> AiAdvisorViewModel(container.aiAdvisorRepository) as T
        AiBriefingViewModel::class.java -> AiBriefingViewModel(container.aiAdvisorRepository) as T
        AiNeedsAttentionViewModel::class.java -> AiNeedsAttentionViewModel(container.aiAdvisorRepository) as T
        AiHistoryViewModel::class.java -> AiHistoryViewModel(container.aiAdvisorRepository) as T
        else -> throw IllegalArgumentException("Unknown ViewModel class: $modelClass")
    }
}
