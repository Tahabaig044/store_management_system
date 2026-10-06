package com.akvisionflow.owner.core.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AssistChip
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.akvisionflow.owner.core.filters.DashboardRange

/**
 * Centralized period/branch/category/business-area filter, shared by every
 * dashboard-related screen (Home, Analytics). A horizontally scrolling chip
 * row - deliberately compact per the phase's "mobile-first" UX guidance.
 */
@Composable
fun FilterBar(
    selectedRange: DashboardRange,
    onRangeSelected: (DashboardRange) -> Unit,
    branchLabel: String,
    onBranchClick: () -> Unit,
    categoryLabel: String,
    onCategoryClick: () -> Unit,
    businessAreaLabel: String,
    onBusinessAreaClick: () -> Unit,
    modifier: Modifier = Modifier,
    // Shown only for a business with more than one company.
    companyLabel: String? = null,
    onCompanyClick: () -> Unit = {},
) {
    LazyRow(
        modifier = modifier,
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(DashboardRange.entries.toList()) { range ->
            FilterChip(
                selected = range == selectedRange,
                onClick = { onRangeSelected(range) },
                label = { Text(range.label) },
            )
        }
        if (companyLabel != null) {
            item {
                AssistChip(onClick = onCompanyClick, label = { Text(companyLabel) })
            }
        }
        item {
            AssistChip(onClick = onBranchClick, label = { Text(branchLabel) })
        }
        item {
            AssistChip(onClick = onCategoryClick, label = { Text(categoryLabel) })
        }
        item {
            AssistChip(onClick = onBusinessAreaClick, label = { Text(businessAreaLabel) })
        }
    }
}
