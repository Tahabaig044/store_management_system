package com.akvisionflow.owner.core.util

import java.util.Locale

object Formatting {
    fun money(amount: Double, currencyCode: String? = null): String {
        val formatted = String.format(Locale.US, "%,.2f", amount)
        return if (currencyCode != null) "$currencyCode $formatted" else formatted
    }

    fun percent(value: Double?): String {
        if (value == null) return "—"
        val sign = if (value > 0) "+" else ""
        return "$sign${String.format(Locale.US, "%.1f", value)}%"
    }

    fun quantity(value: Double): String {
        return if (value == value.toLong().toDouble()) {
            value.toLong().toString()
        } else {
            String.format(Locale.US, "%.1f", value)
        }
    }
}
