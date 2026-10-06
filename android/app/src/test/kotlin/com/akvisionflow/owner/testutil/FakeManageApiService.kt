package com.akvisionflow.owner.testutil

import com.akvisionflow.owner.core.network.ManageApiService
import com.akvisionflow.owner.core.network.dto.CustomerDto
import com.akvisionflow.owner.core.network.dto.CustomerHistoryDto
import com.akvisionflow.owner.core.network.dto.EmptyBody
import com.akvisionflow.owner.core.network.dto.ItemDto
import com.akvisionflow.owner.core.network.dto.PagedDto
import com.akvisionflow.owner.core.network.dto.ProductDto
import com.akvisionflow.owner.core.network.dto.PurchaseDto
import com.akvisionflow.owner.core.network.dto.PurchaseOrderDto
import com.akvisionflow.owner.core.network.dto.PurchaseRequestDto
import com.akvisionflow.owner.core.network.dto.RejectRequest
import com.akvisionflow.owner.core.network.dto.SaleDto
import com.akvisionflow.owner.core.network.dto.StockTransferDto
import com.akvisionflow.owner.core.network.dto.SupplierDto
import com.akvisionflow.owner.core.network.dto.SupplierLedgerDto
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import retrofit2.Response

/**
 * Answers with the REAL saved server responses (test/resources/contract), decoded by the app's own DTOs - so every
 * test that uses it is also a contract test. Records what was asked, and can be told to fail, to report a bigger
 * total (to test paging), or to answer an approval with a given HTTP status.
 */
class FakeManageApiService : ManageApiService {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    private fun raw(name: String) = checkNotNull(javaClass.getResourceAsStream("/contract/$name.json")) { "missing $name" }.bufferedReader().readText()
    private fun <T> fixture(name: String, s: KSerializer<T>): T = json.decodeFromString(s, raw(name))

    val listQueries = mutableListOf<Pair<String, Map<String, String>>>()
    val decisions = mutableListOf<String>()
    var failWith: Throwable? = null

    /** HTTP status to answer approvals with; 200 = success. */
    var decisionStatus = 200
    var decisionBody = """{"error":"Only a pending request can be approved","code":"CONFLICT"}"""
    var pagedTotal: Int? = null
    var pageSizeOverride: Int? = null

    private fun <T> ok(v: T): Response<T> {
        failWith?.let { throw it }
        return Response.success(v)
    }

    private fun <T> paged(name: String, s: KSerializer<PagedDto<T>>, q: Map<String, String>, key: String): Response<PagedDto<T>> {
        listQueries += key to q
        val base = fixture(name, s)
        val page = q["page"]?.toInt() ?: 1
        return ok(base.copy(page = page, pageSize = pageSizeOverride ?: base.pageSize, total = pagedTotal ?: base.total))
    }

    override suspend fun customers(q: Map<String, String>) = paged("customers-list", PagedDto.serializer(CustomerDto.serializer()), q, "customers")
    override suspend fun customer(id: String) = ok(fixture("customer-detail", ItemDto.serializer(CustomerDto.serializer())))
    override suspend fun customerHistory(id: String) = ok(fixture("customer-history", CustomerHistoryDto.serializer()))
    override suspend fun suppliers(q: Map<String, String>) = paged("suppliers-list", PagedDto.serializer(SupplierDto.serializer()), q, "suppliers")
    override suspend fun supplier(id: String) = ok(fixture("suppliers-list", PagedDto.serializer(SupplierDto.serializer())).let { ItemDto(it.items.first()) })
    override suspend fun supplierLedger(id: String) = ok(fixture("supplier-ledger", SupplierLedgerDto.serializer()))
    override suspend fun products(q: Map<String, String>) = paged("products-list", PagedDto.serializer(ProductDto.serializer()), q, "products")
    override suspend fun product(id: String) = ok(fixture("product-detail", ItemDto.serializer(ProductDto.serializer())))
    override suspend fun sales(q: Map<String, String>) = paged("sales-list", PagedDto.serializer(SaleDto.serializer()), q, "sales")
    override suspend fun sale(id: String) = ok(fixture("sale-detail", ItemDto.serializer(SaleDto.serializer())))
    override suspend fun purchases(q: Map<String, String>) = paged("purchases-list", PagedDto.serializer(PurchaseDto.serializer()), q, "purchases")
    override suspend fun purchase(id: String) = ok(fixture("purchase-detail", ItemDto.serializer(PurchaseDto.serializer())))
    override suspend fun purchaseRequests(q: Map<String, String>) = paged("purchase-requests-list", PagedDto.serializer(PurchaseRequestDto.serializer()), q, "purchase-requests")
    override suspend fun purchaseRequest(id: String) = ok(fixture("purchase-request-detail", ItemDto.serializer(PurchaseRequestDto.serializer())))
    override suspend fun purchaseOrders(q: Map<String, String>) = paged("purchase-orders-list", PagedDto.serializer(PurchaseOrderDto.serializer()), q, "purchase-orders")
    override suspend fun purchaseOrder(id: String) = ok(fixture("purchase-order-detail", ItemDto.serializer(PurchaseOrderDto.serializer())))
    override suspend fun stockTransfers(q: Map<String, String>) = paged("stock-transfers-list", PagedDto.serializer(StockTransferDto.serializer()), q, "stock-transfers")
    override suspend fun stockTransfer(id: String) = ok(fixture("stock-transfer-detail", ItemDto.serializer(StockTransferDto.serializer())))

    private fun <T> answer(record: String, s: KSerializer<ItemDto<T>>, fixtureName: String): Response<ItemDto<T>> {
        decisions += record
        failWith?.let { throw it }
        return if (decisionStatus == 200) {
            Response.success(fixture(fixtureName, s))
        } else {
            Response.error(decisionStatus, decisionBody.toResponseBody("application/json".toMediaType()))
        }
    }

    override suspend fun approvePurchaseRequest(id: String, body: EmptyBody) = answer("purchase-requests/approve:$id", ItemDto.serializer(PurchaseRequestDto.serializer()), "purchase-request-detail")
    override suspend fun rejectPurchaseRequest(id: String, body: RejectRequest) = answer("purchase-requests/reject:$id:${body.reason}", ItemDto.serializer(PurchaseRequestDto.serializer()), "purchase-request-detail")
    override suspend fun approvePurchaseOrder(id: String, body: EmptyBody) = answer("purchase-orders/approve:$id", ItemDto.serializer(PurchaseOrderDto.serializer()), "purchase-order-detail")
    override suspend fun rejectPurchaseOrder(id: String, body: RejectRequest) = answer("purchase-orders/reject:$id:${body.reason}", ItemDto.serializer(PurchaseOrderDto.serializer()), "purchase-order-detail")
    override suspend fun approveStockTransfer(id: String, body: EmptyBody) = answer("stock-transfers/approve:$id", ItemDto.serializer(StockTransferDto.serializer()), "stock-transfer-detail")
    override suspend fun rejectStockTransfer(id: String, body: RejectRequest) = answer("stock-transfers/reject:$id:${body.reason}", ItemDto.serializer(StockTransferDto.serializer()), "stock-transfer-detail")
}
