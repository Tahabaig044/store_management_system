package com.akvisionflow.owner.feature.profile

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun ProfileScreen(
    viewModel: ProfileViewModel,
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()

    Scaffold(modifier = modifier) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(24.dp),
        ) {
            Text(text = "Profile", style = MaterialTheme.typography.headlineMedium)
            Spacer(modifier = Modifier.height(16.dp))

            when {
                uiState.isLoading && uiState.profile == null -> {
                    Column(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        CircularProgressIndicator()
                    }
                }
                uiState.profile != null -> {
                    val profile = uiState.profile!!
                    ProfileRow(label = "Name", value = profile.user.name)
                    ProfileRow(label = "Email", value = profile.user.email)
                    ProfileRow(label = "Role", value = roleLabel(profile.access?.role ?: profile.user.role))
                    profile.access?.let { ProfileRow(label = "Branch access", value = if (it.branchRestricted) "Selected branches only" else "All branches") }
                    HorizontalDivider(modifier = Modifier.padding(vertical = 12.dp))
                    ProfileRow(label = "Business", value = profile.tenant.businessName)
                    profile.branch?.let { ProfileRow(label = "Branch", value = it.name) }
                    ProfileRow(label = "Currency", value = profile.tenant.currency)
                }
                uiState.errorMessage != null -> {
                    Text(text = uiState.errorMessage ?: "", color = MaterialTheme.colorScheme.error)
                    Spacer(modifier = Modifier.height(12.dp))
                    Button(onClick = { viewModel.load(forceRefresh = true) }) {
                        Text("Retry")
                    }
                }
            }

            Spacer(modifier = Modifier.weight(1f, fill = true))

            Button(
                onClick = viewModel::logout,
                enabled = !uiState.isLoggingOut,
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (uiState.isLoggingOut) {
                    CircularProgressIndicator(modifier = Modifier.height(20.dp), strokeWidth = 2.dp)
                } else {
                    Text("Log out")
                }
            }
        }
    }
}

@Composable
private fun ProfileRow(label: String, value: String) {
    Column(modifier = Modifier.padding(vertical = 6.dp)) {
        Text(text = label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(text = value, style = MaterialTheme.typography.bodyLarge)
    }
}

/** Plain-language name of a backend role, for display only. The app shows access; the server decides it. */
internal fun roleLabel(role: String): String = when (role) {
    "TENANT_ADMIN" -> "Owner (view only)"
    "MANAGER" -> "Manager (view only)"
    else -> role.lowercase().replaceFirstChar { it.uppercase() }
}
