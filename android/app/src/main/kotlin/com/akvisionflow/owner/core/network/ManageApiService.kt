package com.akvisionflow.owner.core.network

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
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.QueryMap

/**
 * Phase 4.3: the management screens talk to the EXISTING web endpoints (the same routes, rules, permissions and
 * branch scope the web app uses) through the backend's mobile allow-list - see backend middleware/mobileGateway.js.
 * Only what is listed there is reachable with a mobile session; this interface mirrors exactly that list, and
 * contains no create/edit/delete call to add by mistake.
 */
interface ManageApiService {

    @GET("customers") suspend fun customers(@QueryMap q: Map<String, String>): Response<PagedDto<CustomerDto>>
    @GET("customers/{id}") suspend fun customer(@Path("id") id: String): Response<ItemDto<CustomerDto>>
    @GET("customers/{id}/history") suspend fun customerHistory(@Path("id") id: String): Response<CustomerHistoryDto>

    @GET("suppliers") suspend fun suppliers(@QueryMap q: Map<String, String>): Response<PagedDto<SupplierDto>>
    @GET("suppliers/{id}") suspend fun supplier(@Path("id") id: String): Response<ItemDto<SupplierDto>>
    @GET("suppliers/{id}/ledger") suspend fun supplierLedger(@Path("id") id: String): Response<SupplierLedgerDto>

    @GET("products") suspend fun products(@QueryMap q: Map<String, String>): Response<PagedDto<ProductDto>>
    @GET("products/{id}") suspend fun product(@Path("id") id: String): Response<ItemDto<ProductDto>>

    @GET("sales") suspend fun sales(@QueryMap q: Map<String, String>): Response<PagedDto<SaleDto>>
    @GET("sales/{id}") suspend fun sale(@Path("id") id: String): Response<ItemDto<SaleDto>>

    @GET("purchases") suspend fun purchases(@QueryMap q: Map<String, String>): Response<PagedDto<PurchaseDto>>
    @GET("purchases/{id}") suspend fun purchase(@Path("id") id: String): Response<ItemDto<PurchaseDto>>

    @GET("procurement/purchase-requests") suspend fun purchaseRequests(@QueryMap q: Map<String, String>): Response<PagedDto<PurchaseRequestDto>>
    @GET("procurement/purchase-requests/{id}") suspend fun purchaseRequest(@Path("id") id: String): Response<ItemDto<PurchaseRequestDto>>
    @POST("procurement/purchase-requests/{id}/approve") suspend fun approvePurchaseRequest(@Path("id") id: String, @Body body: EmptyBody): Response<ItemDto<PurchaseRequestDto>>
    @POST("procurement/purchase-requests/{id}/reject") suspend fun rejectPurchaseRequest(@Path("id") id: String, @Body body: RejectRequest): Response<ItemDto<PurchaseRequestDto>>

    @GET("procurement/purchase-orders") suspend fun purchaseOrders(@QueryMap q: Map<String, String>): Response<PagedDto<PurchaseOrderDto>>
    @GET("procurement/purchase-orders/{id}") suspend fun purchaseOrder(@Path("id") id: String): Response<ItemDto<PurchaseOrderDto>>
    @POST("procurement/purchase-orders/{id}/approve") suspend fun approvePurchaseOrder(@Path("id") id: String, @Body body: EmptyBody): Response<ItemDto<PurchaseOrderDto>>
    @POST("procurement/purchase-orders/{id}/reject") suspend fun rejectPurchaseOrder(@Path("id") id: String, @Body body: RejectRequest): Response<ItemDto<PurchaseOrderDto>>

    @GET("stock-transfers") suspend fun stockTransfers(@QueryMap q: Map<String, String>): Response<PagedDto<StockTransferDto>>
    @GET("stock-transfers/{id}") suspend fun stockTransfer(@Path("id") id: String): Response<ItemDto<StockTransferDto>>
    @POST("stock-transfers/{id}/approve") suspend fun approveStockTransfer(@Path("id") id: String, @Body body: EmptyBody): Response<ItemDto<StockTransferDto>>
    @POST("stock-transfers/{id}/reject") suspend fun rejectStockTransfer(@Path("id") id: String, @Body body: RejectRequest): Response<ItemDto<StockTransferDto>>
}
