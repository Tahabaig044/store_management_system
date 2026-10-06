package com.akvisionflow.owner.feature.aiadvisor

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AiInsightDetailScreen(
    viewModel: AiInsightDetailViewModel,
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()

    Scaffold(
        modifier = modifier,
        topBar = { TopAppBar(title = { Text("Insight Detail") }) },
    ) { padding ->
        when {
            uiState.isLoading && uiState.insight == null -> {
                Column(Modifier.fillMaxSize().padding(padding), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator()
                }
            }
            uiState.errorMessage != null && uiState.insight == null -> {
                Column(Modifier.fillMaxSize().padding(padding).padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(uiState.errorMessage ?: "", color = MaterialTheme.colorScheme.error)
                    Button(onClick = viewModel::load, modifier = Modifier.padding(top = 12.dp)) { Text("Retry") }
                }
            }
            uiState.insight != null -> {
                val insight = uiState.insight!!
                LazyColumn(
                    modifier = Modifier.fillMaxSize().padding(padding),
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    item {
                        Text(
                            INSIGHT_TYPE_LABEL[insight.insightType] ?: insight.insightType,
                            style = MaterialTheme.typography.labelLarge,
                            color = INSIGHT_TYPE_COLOR[insight.insightType] ?: MaterialTheme.colorScheme.primary,
                        )
                        Text(insight.title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(top = 4.dp))
                    }
                    item {
                        Card(modifier = Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(16.dp)) {
                                Text("What happened", style = MaterialTheme.typography.titleSmall)
                                Text(insight.summary, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 6.dp))
                            }
                        }
                    }
                    insight.recommendedAction?.let { action ->
                        item {
                            Card(modifier = Modifier.fillMaxWidth()) {
                                Column(Modifier.padding(16.dp)) {
                                    Text("What to consider", style = MaterialTheme.typography.titleSmall)
                                    Text(action, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 6.dp))
                                }
                            }
                        }
                    }
                    item {
                        Card(modifier = Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(16.dp)) {
                                Text("Evidence", style = MaterialTheme.typography.titleSmall)
                                JsonEvidenceView(insight.evidence, modifier = Modifier.padding(top = 8.dp))
                            }
                        }
                    }
                    if (!insight.isDismissed) {
                        item {
                            Button(
                                onClick = viewModel::dismiss,
                                enabled = !uiState.isActing,
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text(if (uiState.isActing) "Dismissing…" else "Dismiss")
                            }
                        }
                    } else {
                        item {
                            Text(
                                "Dismissed",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(top = 4.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}
