package com.akvisionflow.owner.core.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.DateRangePicker
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDateRangePickerState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import java.time.Instant
import java.time.ZoneOffset

/** A "Custom Range" date picker for the Date business filter (Phase 2 spec). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CustomDateRangeDialog(
    onDismiss: () -> Unit,
    onConfirm: (fromIso: String, toIso: String) -> Unit,
) {
    val state = rememberDateRangePickerState()

    Dialog(onDismissRequest = onDismiss) {
        Surface(shape = MaterialTheme.shapes.large) {
            Column(modifier = Modifier.heightIn(max = 560.dp)) {
                DateRangePicker(state = state, modifier = Modifier.weight(1f, fill = false))
                Row(
                    modifier = Modifier.padding(16.dp),
                    horizontalArrangement = Arrangement.End,
                ) {
                    TextButton(onClick = onDismiss) { Text("Cancel") }
                    TextButton(
                        onClick = {
                            val from = state.selectedStartDateMillis
                            val to = state.selectedEndDateMillis
                            if (from != null && to != null) {
                                onConfirm(isoDate(from), isoDate(to))
                            }
                        },
                    ) { Text("Apply") }
                }
            }
        }
    }
}

private fun isoDate(epochMillis: Long): String =
    Instant.ofEpochMilli(epochMillis).atZone(ZoneOffset.UTC).toLocalDate().toString()
