package com.akvisionflow.owner.feature.alerts

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.akvisionflow.owner.core.network.dto.AlertDto
import com.akvisionflow.owner.core.network.dto.NotificationPreferencesDto
import com.akvisionflow.owner.core.network.dto.UpdateNotificationPreferencesRequest

private val PRIORITY_ORDER = listOf("CRITICAL", "IMPORTANT", "INFORMATIONAL")
private val PRIORITY_LABEL = mapOf("CRITICAL" to "Critical", "IMPORTANT" to "Important", "INFORMATIONAL" to "Informational")
private val PRIORITY_COLOR = mapOf(
    "CRITICAL" to Color(0xFFC62828),
    "IMPORTANT" to Color(0xFFF9A825),
    "INFORMATIONAL" to Color(0xFF2E7D32),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AlertsScreen(
    viewModel: AlertsViewModel,
    onNavigateToDeepLink: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()

    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text("Alerts") },
                actions = {
                    IconButton(onClick = viewModel::openPreferences) {
                        Icon(Icons.Filled.Settings, contentDescription = "Notification preferences")
                    }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            when {
                uiState.isLoading && uiState.alerts.isEmpty() -> {
                    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator()
                    }
                }
                uiState.alerts.isEmpty() -> {
                    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("No alerts right now.", style = MaterialTheme.typography.bodyLarge)
                        Text("We'll let you know when something needs your attention.", style = MaterialTheme.typography.bodySmall)
                    }
                }
                else -> {
                    val grouped = PRIORITY_ORDER.mapNotNull { priority ->
                        val forPriority = uiState.alerts.filter { it.priority == priority }
                        if (forPriority.isEmpty()) null else priority to forPriority
                    }
                    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        for ((priority, alerts) in grouped) {
                            item {
                                Text(
                                    PRIORITY_LABEL[priority] ?: priority,
                                    style = MaterialTheme.typography.titleMedium,
                                    color = PRIORITY_COLOR[priority] ?: MaterialTheme.colorScheme.onSurface,
                                    modifier = Modifier.padding(top = 8.dp),
                                )
                            }
                            items(alerts) { alert ->
                                AlertRow(
                                    alert = alert,
                                    onOpen = {
                                        if (!alert.isRead) viewModel.markRead(alert.id)
                                        onNavigateToDeepLink(alert.deepLink)
                                    },
                                    onDismiss = { viewModel.dismiss(alert.id) },
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    if (uiState.showPreferences) {
        NotificationPreferencesDialog(
            preferences = uiState.preferences,
            onDismiss = viewModel::closePreferences,
            onUpdate = viewModel::updatePreferences,
        )
    }
}

@Composable
private fun AlertRow(alert: AlertDto, onOpen: () -> Unit, onDismiss: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onOpen)
                .padding(12.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Box(
                modifier = Modifier
                    .padding(top = 6.dp, end = 10.dp)
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(if (alert.isRead) Color.Transparent else (PRIORITY_COLOR[alert.priority] ?: Color.Gray)),
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(alert.title, style = MaterialTheme.typography.titleSmall)
                Text(alert.summary, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 2.dp))
                Text(alert.createdAt.take(10), style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(top = 4.dp))
            }
            IconButton(onClick = onDismiss) {
                Icon(Icons.Filled.Close, contentDescription = "Dismiss alert")
            }
        }
    }
}

@Composable
private fun NotificationPreferencesDialog(
    preferences: NotificationPreferencesDto?,
    onDismiss: () -> Unit,
    onUpdate: (UpdateNotificationPreferencesRequest) -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Notification Preferences") },
        text = {
            if (preferences == null) {
                CircularProgressIndicator()
            } else {
                Column {
                    PreferenceToggle("Daily Summary", preferences.dailySummaryEnabled) {
                        onUpdate(UpdateNotificationPreferencesRequest(dailySummaryEnabled = it))
                    }
                    PreferenceToggle("Sales Alerts", preferences.salesAlertsEnabled) {
                        onUpdate(UpdateNotificationPreferencesRequest(salesAlertsEnabled = it))
                    }
                    PreferenceToggle("Profit Alerts", preferences.profitAlertsEnabled) {
                        onUpdate(UpdateNotificationPreferencesRequest(profitAlertsEnabled = it))
                    }
                    PreferenceToggle("Receivable Alerts", preferences.receivableAlertsEnabled) {
                        onUpdate(UpdateNotificationPreferencesRequest(receivableAlertsEnabled = it))
                    }
                    PreferenceToggle("Inventory Alerts", preferences.inventoryAlertsEnabled) {
                        onUpdate(UpdateNotificationPreferencesRequest(inventoryAlertsEnabled = it))
                    }
                    PreferenceToggle("Expense/Anomaly Alerts", preferences.expenseAnomalyAlertsEnabled) {
                        onUpdate(UpdateNotificationPreferencesRequest(expenseAnomalyAlertsEnabled = it))
                    }
                    Spacer(Modifier.padding(top = 8.dp))
                    Text("Minimum Priority", style = MaterialTheme.typography.labelLarge)
                    listOf("CRITICAL_ONLY" to "Critical only", "IMPORTANT_PLUS" to "Important+", "ALL" to "All").forEach { (value, label) ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { onUpdate(UpdateNotificationPreferencesRequest(minimumPriority = value)) },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(
                                selected = preferences.minimumPriority == value,
                                onClick = { onUpdate(UpdateNotificationPreferencesRequest(minimumPriority = value)) },
                            )
                            Text(label)
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("Done") }
        },
    )
}

@Composable
private fun PreferenceToggle(label: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}
