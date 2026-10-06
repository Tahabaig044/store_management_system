package com.akvisionflow.owner.feature.manage

import com.akvisionflow.owner.core.data.SessionContext

/**
 * The management areas of the app. [viewPermission] is the backend catalog key the list/detail routes require and
 * [decidePermission] the one an approval requires - the same keys the server enforces; the app only uses them to
 * avoid offering what the server would refuse.
 */
enum class ManageKind(val label: String, val viewPermission: String, val decidePermission: String? = null, val searchable: Boolean = true) {
    CUSTOMERS("Customers", "CUSTOMER:VIEW"),
    SUPPLIERS("Suppliers", "SUPPLIER:VIEW"),
    PRODUCTS("Products & Stock", "PRODUCT:VIEW"),
    SALES("Sales", "SALE:VIEW"),
    PURCHASES("Purchases", "PURCHASE:VIEW"),
    PURCHASE_REQUESTS("Purchase Requests", "PURCHASE_REQUEST:VIEW", "PURCHASE_REQUEST:APPROVE", searchable = false),
    PURCHASE_ORDERS("Purchase Orders", "PURCHASE_ORDER:VIEW", "PURCHASE_ORDER:APPROVE", searchable = false),
    STOCK_TRANSFERS("Stock Transfers", "STOCK_TRANSFER:VIEW", "STOCK_TRANSFER:APPROVE", searchable = false),
    ;

    val isApprovalKind: Boolean get() = decidePermission != null
}

/** The areas this session may open, in display order (approvals last). */
fun visibleKinds(context: SessionContext?): List<ManageKind> = ManageKind.entries.filter { context?.can(it.viewPermission) == true }

/** One line of a list. */
data class Row(val id: String, val title: String, val subtitle: String? = null, val trailing: String? = null, val status: String? = null)

data class Page(val rows: List<Row>, val total: Int, val page: Int, val pageSize: Int) {
    val hasMore: Boolean get() = page * pageSize < total
}

data class Field(val label: String, val value: String)
data class Line(val title: String, val subtitle: String? = null, val amount: String? = null)
data class Section(val title: String, val lines: List<Line>)

/** A document or record as the detail screen shows it. */
data class Detail(
    val kind: ManageKind,
    val id: String,
    val title: String,
    val status: String? = null,
    val fields: List<Field> = emptyList(),
    val sections: List<Section> = emptyList(),
    /** True while an approval document is still waiting for a decision. */
    val awaitingDecision: Boolean = false,
)

/** The status the backend uses for a document that is waiting to be approved or rejected. */
const val PENDING_APPROVAL = "PENDING_APPROVAL"

/** What the person may do with a document right now (and only offered - the server decides). */
fun canDecide(context: SessionContext?, detail: Detail): Boolean =
    detail.awaitingDecision && detail.kind.decidePermission?.let { context?.can(it) } == true
