package com.akvisionflow.owner.core.ui.components

import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.akvisionflow.owner.core.filters.DashboardFilters
import com.akvisionflow.owner.core.filters.DashboardRange
import com.akvisionflow.owner.core.network.dto.DashboardFiltersResponse

private val BUSINESS_AREA_LABELS = mapOf(
    "GENERAL" to "General",
    "MEDICINE" to "Medicine",
    "FRAME" to "Frames",
    "LENS" to "Lenses",
)

/**
 * The full Phase 2 "Business Filters" surface (Date/Branch/Business
 * Area/Category), bundled as one composable so Home and Analytics share
 * identical filter behavior rather than duplicating dialog code.
 */
@Composable
fun DashboardFilterControls(
    filters: DashboardFilters,
    filterOptions: DashboardFiltersResponse?,
    onRangeSelected: (DashboardRange) -> Unit,
    onCustomRangeSelected: (fromIso: String, toIso: String) -> Unit,
    onBranchSelected: (id: String?, name: String?) -> Unit,
    onCategorySelected: (id: String?, name: String?) -> Unit,
    onBusinessAreaSelected: (area: String?) -> Unit,
    modifier: Modifier = Modifier,
    onCompanySelected: (id: String?, name: String?) -> Unit = { _, _ -> },
) {
    var showCompanyPicker by remember { mutableStateOf(false) }
    var showBranchPicker by remember { mutableStateOf(false) }
    var showCategoryPicker by remember { mutableStateOf(false) }
    var showBusinessAreaPicker by remember { mutableStateOf(false) }
    var showCustomRangePicker by remember { mutableStateOf(false) }

    FilterBar(
        selectedRange = filters.range,
        onRangeSelected = { range ->
            if (range == DashboardRange.CUSTOM) showCustomRangePicker = true else onRangeSelected(range)
        },
        branchLabel = filters.branchLabel,
        onBranchClick = { showBranchPicker = true },
        categoryLabel = filters.categoryLabel,
        onCategoryClick = { showCategoryPicker = true },
        businessAreaLabel = filters.businessAreaLabel,
        onBusinessAreaClick = { showBusinessAreaPicker = true },
        modifier = modifier,
        // Only a business with several companies needs the company filter.
        companyLabel = if ((filterOptions?.companies?.size ?: 0) > 1) filters.companyLabel else null,
        onCompanyClick = { showCompanyPicker = true },
    )

    if (showCompanyPicker) {
        val options = filterOptions?.companies ?: emptyList()
        AlertDialog(
            onDismissRequest = { showCompanyPicker = false },
            title = { Text("Select company") },
            text = {
                LazyColumn {
                    item {
                        TextButton(onClick = { onCompanySelected(null, null); showCompanyPicker = false }) { Text("All Companies") }
                    }
                    items(options) { company ->
                        TextButton(onClick = { onCompanySelected(company.id, company.name); showCompanyPicker = false }) { Text(company.name) }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { showCompanyPicker = false }) { Text("Close") } },
        )
    }

    if (showBranchPicker) {
        // With a company chosen, only that company's branches are offered.
        val options = (filterOptions?.branches ?: emptyList()).filter { filters.companyId == null || it.companyId == filters.companyId }
        AlertDialog(
            onDismissRequest = { showBranchPicker = false },
            title = { Text("Select branch") },
            text = {
                LazyColumn {
                    item {
                        TextButton(onClick = { onBranchSelected(null, null); showBranchPicker = false }) { Text("All Branches") }
                    }
                    items(options) { branch ->
                        TextButton(onClick = { onBranchSelected(branch.id, branch.name); showBranchPicker = false }) { Text(branch.name) }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { showBranchPicker = false }) { Text("Close") } },
        )
    }

    if (showCategoryPicker) {
        val options = filterOptions?.categories ?: emptyList()
        AlertDialog(
            onDismissRequest = { showCategoryPicker = false },
            title = { Text("Select category") },
            text = {
                LazyColumn {
                    item {
                        TextButton(onClick = { onCategorySelected(null, null); showCategoryPicker = false }) { Text("All Categories") }
                    }
                    items(options) { category ->
                        TextButton(onClick = { onCategorySelected(category.id, category.name); showCategoryPicker = false }) { Text(category.name) }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { showCategoryPicker = false }) { Text("Close") } },
        )
    }

    if (showBusinessAreaPicker) {
        val options = filterOptions?.businessAreas ?: BUSINESS_AREA_LABELS.keys.toList()
        AlertDialog(
            onDismissRequest = { showBusinessAreaPicker = false },
            title = { Text("Select business area") },
            text = {
                LazyColumn {
                    item {
                        TextButton(onClick = { onBusinessAreaSelected(null); showBusinessAreaPicker = false }) { Text("All Areas") }
                    }
                    items(options) { area ->
                        TextButton(onClick = { onBusinessAreaSelected(area); showBusinessAreaPicker = false }) {
                            Text(BUSINESS_AREA_LABELS[area] ?: area)
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { showBusinessAreaPicker = false }) { Text("Close") } },
        )
    }

    if (showCustomRangePicker) {
        CustomDateRangeDialog(
            onDismiss = { showCustomRangePicker = false },
            onConfirm = { from, to ->
                onCustomRangeSelected(from, to)
                showCustomRangePicker = false
            },
        )
    }
}
