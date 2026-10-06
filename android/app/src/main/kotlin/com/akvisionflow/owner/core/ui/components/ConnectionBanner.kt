package com.akvisionflow.owner.core.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

const val CONNECTION_BANNER_TAG = "connection_banner"

/** Shown while the device has no working connection; nothing is drawn while online. */
@Composable
fun ConnectionBanner(isOnline: Boolean, modifier: Modifier = Modifier) {
    if (isOnline) return
    Box(
        modifier = modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.errorContainer)
            .padding(horizontal = 16.dp, vertical = 6.dp)
            .testTag(CONNECTION_BANNER_TAG),
    ) {
        Text(
            text = "You are offline. What you see may be out of date; it will refresh when the connection returns.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onErrorContainer,
        )
    }
}
