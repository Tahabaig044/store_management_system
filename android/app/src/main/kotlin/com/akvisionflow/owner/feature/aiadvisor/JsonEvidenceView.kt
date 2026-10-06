package com.akvisionflow.owner.feature.aiadvisor

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import java.util.Locale
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Renders an [AiInsightDto.evidence] payload as a plain, readable list of
 * label/value rows - "the owner can open an insight and see the evidence
 * behind it" (Phase 4 completion criterion 4), without needing a bespoke
 * Kotlin model per insight type (evidence shape varies: a low-stock risk,
 * an anomaly finding, and the full daily brief object all look different).
 * Every number/string shown here comes directly from the backend's
 * evidence field - nothing is computed or embellished client-side.
 */
@Composable
fun JsonEvidenceView(element: JsonElement?, modifier: Modifier = Modifier, depth: Int = 0) {
    if (element == null || element is JsonNull) return
    Column(modifier = modifier) {
        when (element) {
            is JsonObject -> element.entries.forEach { (key, value) ->
                EvidenceEntry(label = humanizeKey(key), value = value, depth = depth)
            }
            is JsonArray -> element.forEachIndexed { index, item ->
                EvidenceEntry(label = "#${index + 1}", value = item, depth = depth)
            }
            else -> Text(primitiveText(element), style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun EvidenceEntry(label: String, value: JsonElement, depth: Int) {
    when (value) {
        is JsonObject, is JsonArray -> {
            if (depth < 3) {
                Text(label, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 8.dp, start = (depth * 12).dp))
                JsonEvidenceView(value, modifier = Modifier.padding(start = ((depth + 1) * 12).dp), depth = depth + 1)
            }
        }
        else -> {
            Row(modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp, horizontal = (depth * 12).dp), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(label, style = MaterialTheme.typography.bodySmall)
                Text(primitiveText(value), style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

private fun primitiveText(element: JsonElement): String {
    val primitive = element as? JsonPrimitive ?: return element.toString()
    if (primitive.isString) return primitive.content
    primitive.booleanOrNull?.let { return if (it) "Yes" else "No" }
    primitive.longOrNull?.let { return it.toString() }
    primitive.doubleOrNull?.let { return String.format(Locale.US, "%.2f", it) }
    return primitive.content
}

private fun humanizeKey(key: String): String {
    val spaced = key.replace(Regex("([a-z])([A-Z])"), "$1 $2")
    return spaced.replaceFirstChar { it.uppercase() }
}
