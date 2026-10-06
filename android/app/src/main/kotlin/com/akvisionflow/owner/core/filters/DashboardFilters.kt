package com.akvisionflow.owner.core.filters

/** The five ranges the backend's resolveRange() understands (dashboardService.js). */
enum class DashboardRange(val apiValue: String, val label: String) {
    TODAY("today", "Today"),
    YESTERDAY("yesterday", "Yesterday"),
    WEEK("week", "This Week"),
    MONTH("month", "This Month"),
    CUSTOM("custom", "Custom"),
}

/**
 * The filter set shared by every dashboard-related screen (Phase 2 spec:
 * "the same selected period/branch context should be preserved when moving
 * between compatible dashboard views"). Held centrally in
 * [DashboardFilterRepository] rather than per-screen state.
 */
data class DashboardFilters(
    val range: DashboardRange = DashboardRange.TODAY,
    val fromIso: String? = null,
    val toIso: String? = null,
    // Phase 4.2: a company narrows the figures to its branches; choosing one clears any branch of another company.
    val companyId: String? = null,
    val companyName: String? = null,
    val branchId: String? = null,
    val branchName: String? = null,
    val categoryId: String? = null,
    val categoryName: String? = null,
    // "Business Area" filter from the phase spec - this schema's closest
    // equivalent to a distinct business line is Product.type (see
    // dashboard.routes.js on the backend).
    val businessArea: String? = null,
) {
    val companyLabel: String get() = companyName ?: "All Companies"
    val branchLabel: String get() = branchName ?: "All Branches"
    val categoryLabel: String get() = categoryName ?: "All Categories"
    val businessAreaLabel: String get() = businessArea?.let { it.lowercase().replaceFirstChar(Char::uppercase) } ?: "All Areas"

    fun toQueryMap(): Map<String, String> {
        val map = mutableMapOf("range" to range.apiValue)
        if (range == DashboardRange.CUSTOM) {
            fromIso?.let { map["from"] = it }
            toIso?.let { map["to"] = it }
        }
        companyId?.let { map["companyId"] = it }
        branchId?.let { map["branchId"] = it }
        categoryId?.let { map["categoryId"] = it }
        businessArea?.let { map["productType"] = it }
        return map
    }
}

/** Picks a company: the branch selection is dropped (it may belong to another company) and the figures follow the company. */
fun DashboardFilters.withCompany(id: String?, name: String?): DashboardFilters = copy(companyId = id, companyName = name, branchId = null, branchName = null)
