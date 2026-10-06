package com.akvisionflow.owner.feature.aiadvisor

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.akvisionflow.owner.core.network.dto.AiInsightDto

internal val INSIGHT_TYPE_LABEL = mapOf(
    "PERFORMANCE" to "Performance",
    "ANOMALY" to "Anomaly",
    "RISK" to "Risk",
    "OPPORTUNITY" to "Opportunity",
    "TREND" to "Trend",
    "RECOMMENDATION" to "Recommendation",
)

internal val INSIGHT_TYPE_COLOR = mapOf(
    "RISK" to Color(0xFFC62828),
    "ANOMALY" to Color(0xFFEF6C00),
    "RECOMMENDATION" to Color(0xFFF9A825),
    "OPPORTUNITY" to Color(0xFF2E7D32),
    "TREND" to Color(0xFF1565C0),
    "PERFORMANCE" to Color(0xFF6A1B9A),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AiAdvisorScreen(
    viewModel: AiAdvisorViewModel,
    onOpenBriefing: () -> Unit,
    onOpenNeedsAttention: () -> Unit,
    onOpenHistory: () -> Unit,
    onOpenInsight: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()

    Scaffold(
        modifier = modifier,
        topBar = { TopAppBar(title = { Text("AI Advisor") }) },
    ) { padding ->
        when {
            uiState.isLoading && uiState.home == null -> {
                Column(Modifier.fillMaxSize().padding(padding), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator()
                }
            }
            uiState.errorMessage != null && uiState.home == null -> {
                Column(Modifier.fillMaxSize().padding(padding).padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(uiState.errorMessage ?: "", color = MaterialTheme.colorScheme.error)
                    Button(onClick = viewModel::load, modifier = Modifier.padding(top = 12.dp)) { Text("Retry") }
                }
            }
            uiState.home != null -> {
                val home = uiState.home!!
                LazyColumn(
                    modifier = Modifier.fillMaxSize().padding(padding),
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    item {
                        Card(modifier = Modifier.fillMaxWidth().clickable(onClick = onOpenBriefing)) {
                            Column(Modifier.padding(16.dp)) {
                                Text("Today's Business Advice", style = MaterialTheme.typography.titleMedium)
                                Text(home.dailyAdvice.summary, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 8.dp))
                                Text("Tap for full briefing", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 8.dp))
                            }
                        }
                    }

                    home.trend?.let { trend ->
                        item {
                            Card(modifier = Modifier.fillMaxWidth()) {
                                Column(Modifier.padding(16.dp)) {
                                    Text(trend.title, style = MaterialTheme.typography.titleSmall, color = INSIGHT_TYPE_COLOR["TREND"] ?: MaterialTheme.colorScheme.primary)
                                    Text(trend.summary, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 6.dp))
                                }
                            }
                        }
                    }

                    item {
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Text("Needs Attention", style = MaterialTheme.typography.titleMedium)
                            Text("See all (${home.counts.total})", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.clickable(onClick = onOpenNeedsAttention))
                        }
                    }
                    if (home.needsAttention.isEmpty()) {
                        item { Text("Nothing needs attention right now.", style = MaterialTheme.typography.bodyMedium) }
                    }
                    items(home.needsAttention) { insight ->
                        NeedsAttentionRow(insight, onClick = { insight.id?.let(onOpenInsight) })
                    }

                    item {
                        Text(
                            "View AI History",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.padding(top = 8.dp).clickable(onClick = onOpenHistory),
                        )
                    }
                }
            }
        }
    }
}

@Composable
internal fun NeedsAttentionRow(insight: AiInsightDto, onClick: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Row(modifier = Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.Top) {
            RankBadge(insight.rank)
            Column(modifier = Modifier.weight(1f).padding(start = 8.dp)) {
                Text(insight.title, style = MaterialTheme.typography.titleSmall)
                Text(insight.summary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 2.dp))
                Text(
                    INSIGHT_TYPE_LABEL[insight.insightType] ?: insight.insightType,
                    style = MaterialTheme.typography.labelSmall,
                    color = INSIGHT_TYPE_COLOR[insight.insightType] ?: MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
    }
}

@Composable
private fun RankBadge(rank: Int?) {
    androidx.compose.foundation.layout.Box(
        modifier = Modifier
            .size(24.dp)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.primaryContainer),
        contentAlignment = Alignment.Center,
    ) {
        Text((rank ?: 0).toString(), style = MaterialTheme.typography.labelSmall)
    }
}
