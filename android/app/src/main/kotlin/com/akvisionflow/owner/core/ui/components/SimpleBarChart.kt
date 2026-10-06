package com.akvisionflow.owner.core.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.unit.dp

/**
 * A deliberately minimal Canvas-based bar chart - no charting library
 * dependency, keeping the app lightweight per the Phase 1 architecture
 * principle. Readable at phone width: a handful of bars, no axis clutter,
 * matching the "compact visual trends... must remain readable on small
 * screens" requirement.
 */
@Composable
fun SimpleBarChart(
    values: List<Float>,
    modifier: Modifier = Modifier,
    barColor: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.primary,
) {
    val maxValue = (values.maxOrNull() ?: 0f).coerceAtLeast(0.0001f)
    Canvas(modifier = modifier.fillMaxWidth().height(120.dp)) {
        if (values.isEmpty()) return@Canvas
        val gap = 4.dp.toPx()
        val barWidth = (size.width - gap * (values.size - 1).coerceAtLeast(0)) / values.size
        values.forEachIndexed { index, value ->
            val barHeight = (value / maxValue) * size.height
            val left = index * (barWidth + gap)
            drawRect(
                color = barColor,
                topLeft = androidx.compose.ui.geometry.Offset(left, size.height - barHeight),
                size = Size(barWidth, barHeight),
            )
        }
    }
}
