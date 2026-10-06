package com.akvisionflow.owner.feature.manage

import com.akvisionflow.owner.core.network.ApiResult
import com.akvisionflow.owner.core.network.ApiResultMapper
import com.akvisionflow.owner.core.network.ManageApiService
import com.akvisionflow.owner.core.network.dto.EmptyBody
import com.akvisionflow.owner.core.network.dto.LineDto
import com.akvisionflow.owner.core.network.dto.PaymentDto
import com.akvisionflow.owner.core.network.dto.RejectRequest
import com.akvisionflow.owner.core.util.Formatting

/**
 * Reads the existing list/detail endpoints and the three approval actions, and shapes what they return into the
 * rows and details the screens show. Nothing is calculated here that the server did not already compute (totals,
 * balances, statuses); this layer only formats and labels.
 */
class ManageRepository(
    private val api: ManageApiService,
    private val resultMapper: ApiResultMapper,
    private val currency: () -> String? = { null },
) {
    private fun money(v: Double) = Formatting.money(v, currency())
    private fun day(iso: String?) = iso?.take(10)
    private fun qty(v: Double) = Formatting.quantity(v)

    suspend fun list(kind: ManageKind, search: String = "", page: Int = 1): ApiResult<Page> {
        val q = buildMap {
            put("page", page.toString())
            put("pageSize", PAGE_SIZE.toString())
            if (search.isNotBlank() && kind.searchable) put("search", search.trim())
            // The approval queues open on what is waiting for a decision.
            if (kind.isApprovalKind) put("status", PENDING_APPROVAL)
        }
        return when (kind) {
            ManageKind.CUSTOMERS -> paged(resultMapper.execute { api.customers(q) }) { Row(it.id, it.name, listOfNotNull(it.phone, it.email).joinToString(" · ").ifBlank { null }, null, if (it.isActive) null else "INACTIVE") }
            ManageKind.SUPPLIERS -> paged(resultMapper.execute { api.suppliers(q) }) { Row(it.id, it.name, listOfNotNull(it.phone, it.email).joinToString(" · ").ifBlank { null }, null, if (it.isActive) null else "INACTIVE") }
            ManageKind.PRODUCTS -> paged(resultMapper.execute { api.products(q) }) {
                Row(it.id, it.name, listOfNotNull(it.sku, it.barcode).joinToString(" · ").ifBlank { null }, "${qty(it.stockQuantity)} in stock", if (it.stockQuantity <= 0) "OUT_OF_STOCK" else if (it.stockQuantity <= it.lowStockThreshold) "LOW_STOCK" else null)
            }
            ManageKind.SALES -> paged(resultMapper.execute { api.sales(q) }) { Row(it.id, it.invoiceNumber, listOfNotNull(day(it.createdAt), it.customer?.name ?: "Walk-in").joinToString(" · "), money(it.total), it.status) }
            ManageKind.PURCHASES -> paged(resultMapper.execute { api.purchases(q) }) { Row(it.id, it.purchaseNumber, listOfNotNull(day(it.createdAt), it.supplier?.name).joinToString(" · "), money(it.total), it.status) }
            ManageKind.PURCHASE_REQUESTS -> paged(resultMapper.execute { api.purchaseRequests(q) }) { Row(it.id, it.requestNumber, listOfNotNull(day(it.createdAt), it.requestedBy?.name).joinToString(" · "), "${it.items.size} item(s)", it.status) }
            ManageKind.PURCHASE_ORDERS -> paged(resultMapper.execute { api.purchaseOrders(q) }) { Row(it.id, it.poNumber, listOfNotNull(day(it.createdAt), it.supplier?.name).joinToString(" · "), money(it.total), it.status) }
            ManageKind.STOCK_TRANSFERS -> paged(resultMapper.execute { api.stockTransfers(q) }) { Row(it.id, it.transferNumber, "${it.sourceWarehouse?.name ?: "?"} → ${it.destinationWarehouse?.name ?: "?"}", "${it.items.size} item(s)", it.status) }
        }
    }

    private fun <T> paged(result: ApiResult<com.akvisionflow.owner.core.network.dto.PagedDto<T>>, row: (T) -> Row): ApiResult<Page> = when (result) {
        is ApiResult.Success -> ApiResult.Success(Page(result.data.items.map(row), result.data.total, result.data.page, result.data.pageSize))
        is ApiResult.Error -> result
    }

    private fun <A, B> ApiResult<A>.map(f: (A) -> B): ApiResult<B> = when (this) {
        is ApiResult.Success -> ApiResult.Success(f(data))
        is ApiResult.Error -> this
    }

    private fun lines(items: List<LineDto>, showCost: Boolean = false, showPrice: Boolean = true) = items.map {
        Line(
            title = it.product?.name ?: "Item",
            subtitle = "${qty(it.quantity)} × ${money(if (showCost) it.unitCost else it.unitPrice)}".takeIf { showPrice || showCost } ?: qty(it.quantity),
            amount = if (it.lineTotal != 0.0) money(it.lineTotal) else null,
        )
    }

    private fun payments(list: List<PaymentDto>) = list.filter { it.status != "REVERSED" }.map { Line("${it.method ?: "payment"} ${it.direction?.lowercase() ?: ""}".trim(), day(it.paidAt), money(it.amount)) }

    suspend fun detail(kind: ManageKind, id: String): ApiResult<Detail> = when (kind) {
        ManageKind.CUSTOMERS -> {
            val info = resultMapper.execute { api.customer(id) }
            val history = resultMapper.execute { api.customerHistory(id) }
            when {
                info is ApiResult.Error -> info
                else -> {
                    val c = (info as ApiResult.Success).data.item
                    val h = (history as? ApiResult.Success)?.data
                    ApiResult.Success(
                        Detail(
                            kind, c.id, c.name, if (c.isActive) null else "INACTIVE",
                            fields = listOfNotNull(
                                c.phone?.let { Field("Phone", it) }, c.email?.let { Field("Email", it) }, c.address?.let { Field("Address", it) }, c.code?.let { Field("Code", it) },
                                h?.let { Field("Balance due", money(it.balanceDue)) },
                            ),
                            sections = listOfNotNull(
                                h?.sales?.takeIf { it.isNotEmpty() }?.let { s -> Section("Recent sales", s.take(10).map { Line(it.invoiceNumber, "${day(it.createdAt)} · ${it.status}", money(it.total)) }) },
                                h?.payments?.takeIf { it.isNotEmpty() }?.let { Section("Payments", payments(it).take(10)) },
                            ),
                        ),
                    )
                }
            }
        }
        ManageKind.SUPPLIERS -> {
            val info = resultMapper.execute { api.supplier(id) }
            val ledger = resultMapper.execute { api.supplierLedger(id) }
            when {
                info is ApiResult.Error -> info
                else -> {
                    val s = (info as ApiResult.Success).data.item
                    val l = (ledger as? ApiResult.Success)?.data
                    ApiResult.Success(
                        Detail(
                            kind, s.id, s.name, if (s.isActive) null else "INACTIVE",
                            fields = listOfNotNull(
                                s.phone?.let { Field("Phone", it) }, s.email?.let { Field("Email", it) }, s.address?.let { Field("Address", it) }, s.code?.let { Field("Code", it) },
                                l?.let { Field("Balance owed", money(it.balanceDue)) },
                            ),
                            sections = listOfNotNull(
                                l?.purchases?.takeIf { it.isNotEmpty() }?.let { p -> Section("Recent purchases", p.take(10).map { Line(it.purchaseNumber, "${day(it.createdAt)} · ${it.status}", money(it.total)) }) },
                                l?.payments?.takeIf { it.isNotEmpty() }?.let { Section("Payments", payments(it).take(10)) },
                            ),
                        ),
                    )
                }
            }
        }
        ManageKind.PRODUCTS -> resultMapper.execute { api.product(id) }.map { r ->
            val p = r.item
            Detail(
                kind, p.id, p.name, if (p.isActive) null else "INACTIVE",
                fields = listOfNotNull(
                    p.sku?.let { Field("SKU", it) }, p.barcode?.let { Field("Barcode", it) }, p.category?.name?.let { Field("Category", it) },
                    Field("In stock", "${qty(p.stockQuantity)} ${p.unit ?: ""}".trim()), Field("Low-stock level", qty(p.lowStockThreshold)),
                    Field("Selling price", money(p.sellingPrice)), Field("Purchase price", money(p.purchasePrice)),
                ),
            )
        }
        ManageKind.SALES -> resultMapper.execute { api.sale(id) }.map { r ->
            val s = r.item
            Detail(
                kind, s.id, s.invoiceNumber, s.status,
                fields = listOfNotNull(
                    day(s.createdAt)?.let { Field("Date", it) }, Field("Customer", s.customer?.name ?: "Walk-in"), s.cashier?.name?.let { Field("Cashier", it) },
                    Field("Subtotal", money(s.subtotal)), Field("Discount", money(s.discount)), Field("Tax", money(s.tax)), Field("Total", money(s.total)),
                    Field("Paid", money(s.amountPaid)), Field("Balance", money(s.total - s.amountPaid)), s.paymentStatus?.let { Field("Payment", it) },
                ),
                sections = listOfNotNull(Section("Items", lines(s.items)).takeIf { it.lines.isNotEmpty() }, Section("Payments", payments(s.payments)).takeIf { it.lines.isNotEmpty() }),
            )
        }
        ManageKind.PURCHASES -> resultMapper.execute { api.purchase(id) }.map { r ->
            val p = r.item
            Detail(
                kind, p.id, p.purchaseNumber, p.status,
                fields = listOfNotNull(
                    day(p.createdAt)?.let { Field("Date", it) }, p.supplier?.name?.let { Field("Supplier", it) },
                    Field("Total", money(p.total)), Field("Paid", money(p.amountPaid)), Field("Balance", money(p.total - p.amountPaid)), p.paymentStatus?.let { Field("Payment", it) },
                ),
                sections = listOfNotNull(Section("Items", lines(p.items, showCost = true)).takeIf { it.lines.isNotEmpty() }, Section("Payments", payments(p.payments)).takeIf { it.lines.isNotEmpty() }),
            )
        }
        ManageKind.PURCHASE_REQUESTS -> resultMapper.execute { api.purchaseRequest(id) }.map { r ->
            val d = r.item
            Detail(
                kind, d.id, d.requestNumber, d.status,
                fields = listOfNotNull(
                    day(d.createdAt)?.let { Field("Requested", it) }, d.requestedBy?.name?.let { Field("By", it) }, d.branch?.name?.let { Field("Branch", it) },
                    d.notes?.let { Field("Notes", it) }, d.approvedBy?.name?.let { Field("Decided by", it) }, d.rejectionReason?.let { Field("Rejected because", it) },
                ),
                sections = listOf(Section("Items", d.items.map { Line(it.product?.name ?: "Item", it.product?.sku, qty(it.quantity)) })),
                awaitingDecision = d.status == PENDING_APPROVAL,
            )
        }
        ManageKind.PURCHASE_ORDERS -> resultMapper.execute { api.purchaseOrder(id) }.map { r ->
            val d = r.item
            Detail(
                kind, d.id, d.poNumber, d.status,
                fields = listOfNotNull(day(d.createdAt)?.let { Field("Created", it) }, d.supplier?.name?.let { Field("Supplier", it) }, Field("Total", money(d.total)), d.rejectionReason?.let { Field("Rejected because", it) }),
                sections = listOf(Section("Items", lines(d.items, showCost = true))),
                awaitingDecision = d.status == PENDING_APPROVAL,
            )
        }
        ManageKind.STOCK_TRANSFERS -> resultMapper.execute { api.stockTransfer(id) }.map { r ->
            val d = r.item
            Detail(
                kind, d.id, d.transferNumber, d.status,
                fields = listOfNotNull(
                    day(d.createdAt)?.let { Field("Requested", it) }, Field("From", d.sourceWarehouse?.name ?: "?"), Field("To", d.destinationWarehouse?.name ?: "?"),
                    d.notes?.let { Field("Notes", it) }, d.rejectionReason?.let { Field("Rejected because", it) },
                ),
                sections = listOf(Section("Items", d.items.map { Line(it.product?.name ?: "Item", it.product?.sku, qty(it.quantity)) })),
                awaitingDecision = d.status == PENDING_APPROVAL,
            )
        }
    }

    /**
     * Approves (reason ignored) or rejects (reason required) a document. The server flips the status atomically:
     * if somebody else decided it first, this comes back as a conflict, never as a second decision.
     */
    suspend fun decide(kind: ManageKind, id: String, approve: Boolean, reason: String? = null): ApiResult<Unit> {
        if (!approve && reason.isNullOrBlank()) return ApiResult.Error(com.akvisionflow.owner.core.network.ApiErrorKind.VALIDATION, "A reason is required to reject.")
        val why = RejectRequest(reason.orEmpty().trim())
        val result: ApiResult<*> = when (kind) {
            ManageKind.PURCHASE_REQUESTS -> resultMapper.execute { if (approve) api.approvePurchaseRequest(id, EmptyBody()) else api.rejectPurchaseRequest(id, why) }
            ManageKind.PURCHASE_ORDERS -> resultMapper.execute { if (approve) api.approvePurchaseOrder(id, EmptyBody()) else api.rejectPurchaseOrder(id, why) }
            ManageKind.STOCK_TRANSFERS -> resultMapper.execute { if (approve) api.approveStockTransfer(id, EmptyBody()) else api.rejectStockTransfer(id, why) }
            else -> return ApiResult.Error(com.akvisionflow.owner.core.network.ApiErrorKind.FORBIDDEN, "This cannot be approved from the app.")
        }
        return when (result) {
            is ApiResult.Success -> ApiResult.Success(Unit)
            is ApiResult.Error -> result
        }
    }

    companion object {
        const val PAGE_SIZE = 20
    }
}
