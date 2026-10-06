package com.akvisionflow.owner.core.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.akvisionflow.owner.core.util.Formatting

/**
 * One KPI stat card: a label, a big number, and an optional growth/decline
 * badge - the "mobile-first cards with clear numbers and concise labels"
 * pattern required across every dashboard screen.
 */
@Composable
fun KpiCard(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    changePercent: Double? = null,
    onClick: (() -> Unit)? = null,
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .let { if (onClick != null) it.clickable(onClick = onClick) else it },
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(text = label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(text = value, style = MaterialTheme.typography.titleLarge)
                if (changePercent != null) {
                    val color = when {
                        changePercent > 0 -> Color(0xFF2E7D32)
                        changePercent < 0 -> Color(0xFFC62828)
                        else -> MaterialTheme.colorScheme.onSurfaceVariant
                    }
                    Text(text = Formatting.percent(changePercent), color = color, style = MaterialTheme.typography.labelLarge)
                }
            }
        }
    }
}
