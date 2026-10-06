package com.akvisionflow.owner.core.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.akvisionflow.owner.core.AppContainer
import com.akvisionflow.owner.core.ViewModelFactory
import com.akvisionflow.owner.core.data.SessionState
import com.akvisionflow.owner.feature.auth.LoginScreen
import com.akvisionflow.owner.feature.auth.LoginViewModel

/**
 * Root gate: shows the login flow or the authenticated app shell based on
 * [AppContainer.sessionRepository]. This is the single place session state
 * is observed, so an expired/rejected token (ApiResultMapper -> 401 ->
 * SessionRepository.onUnauthorized) always drops the user back to login,
 * from any screen, without each screen needing its own auth check.
 */
@Composable
fun OwnerNavHost(container: AppContainer) {
    val sessionState by container.sessionRepository.state.collectAsStateWithLifecycle()

    when (sessionState) {
        is SessionState.LoggedOut -> {
            val viewModel: LoginViewModel = viewModel(factory = ViewModelFactory(container))
            LoginScreen(viewModel = viewModel, onLoginSuccess = { /* state flip re-composes to MainScaffold */ })
        }
        is SessionState.Authenticated -> {
            MainScaffold(container = container)
        }
    }
}
