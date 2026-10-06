package com.akvisionflow.owner.feature.aiadvisor

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

private val HISTORY_TYPE_FILTERS = listOf(null, "PERFORMANCE", "ANOMALY", "RISK", "OPPORTUNITY", "RECOMMENDATION")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AiHistoryScreen(
    viewModel: AiHistoryViewModel,
    onOpenInsight: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()

    Scaffold(
        modifier = modifier,
        topBar = { TopAppBar(title = { Text("AI History") }) },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            LazyRow(
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(HISTORY_TYPE_FILTERS) { type ->
                    FilterChip(
                        selected = uiState.typeFilter == type,
                        onClick = { viewModel.setTypeFilter(type) },
                        label = { Text(type?.let { INSIGHT_TYPE_LABEL[it] ?: it } ?: "All") },
                    )
                }
            }

            when {
                uiState.isLoading && uiState.items.isEmpty() -> {
                    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator()
                    }
                }
                uiState.errorMessage != null && uiState.items.isEmpty() -> {
                    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(uiState.errorMessage ?: "", color = MaterialTheme.colorScheme.error)
                        Button(onClick = viewModel::load, modifier = Modifier.padding(top = 12.dp)) { Text("Retry") }
                    }
                }
                uiState.items.isEmpty() -> {
                    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("No AI insights yet.", style = MaterialTheme.typography.bodyLarge)
                    }
                }
                else -> {
                    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(uiState.items) { insight ->
                            Card(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable(enabled = insight.id != null) { insight.id?.let(onOpenInsight) },
                            ) {
                                Column(Modifier.padding(12.dp)) {
                                    Text(insight.title, style = MaterialTheme.typography.titleSmall)
                                    Text(insight.summary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 2.dp))
                                    Text(
                                        "${INSIGHT_TYPE_LABEL[insight.insightType] ?: insight.insightType} • ${insight.createdAt.take(10)}${if (insight.isDismissed) " • Dismissed" else ""}",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = INSIGHT_TYPE_COLOR[insight.insightType] ?: MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.padding(top = 4.dp),
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
