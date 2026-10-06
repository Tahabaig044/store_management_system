package com.akvisionflow.owner.core.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val OwnerBlue = Color(0xFF1B4F72)
private val OwnerBlueLight = Color(0xFF2E86C1)
private val OwnerBackground = Color(0xFFF5F7FA)

private val LightColors = lightColorScheme(
    primary = OwnerBlue,
    secondary = OwnerBlueLight,
    background = OwnerBackground,
)

private val DarkColors = darkColorScheme(
    primary = OwnerBlueLight,
    secondary = OwnerBlue,
)

@Composable
fun OwnerAppTheme(
    useDarkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colors = if (useDarkTheme) DarkColors else LightColors
    MaterialTheme(colorScheme = colors, content = content)
}
