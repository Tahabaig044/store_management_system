package com.akvisionflow.owner.core.network.dto

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonPrimitive

// Phase 4.3 - the shapes of the EXISTING web endpoints the management screens read (customers, suppliers,
// products, sales, purchases and the three approval documents). They model only what the screens show; anything
// else the server sends is ignored. Tested against real saved responses (test/resources/contract).

/** The API sends money and quantities as strings ("180") - a database decimal. Accept a string or a number. */
object FlexDouble : KSerializer<Double> {
    override val descriptor = PrimitiveSerialDescriptor("FlexDouble", PrimitiveKind.DOUBLE)
    override fun deserialize(decoder: Decoder): Double {
        val element = (decoder as JsonDecoder).decodeJsonElement()
        return (element as? JsonPrimitive)?.content?.toDoubleOrNull() ?: 0.0
    }
    override fun serialize(encoder: Encoder, value: Double) = encoder.encodeDouble(value)
}

@Serializable data class NameDto(val name: String? = null)

@Serializable
data class PagedDto<T>(val items: List<T> = emptyList(), val total: Int = 0, val page: Int = 1, val pageSize: Int = 20)

@Serializable data class ItemDto<T>(val item: T)

@Serializable
data class CustomerDto(
    val id: String,
    val name: String,
    val phone: String? = null,
    val email: String? = null,
    val address: String? = null,
    val code: String? = null,
    val notes: String? = null,
    val isActive: Boolean = true,
)

@Serializable
data class SupplierDto(
    val id: String,
    val name: String,
    val phone: String? = null,
    val email: String? = null,
    val address: String? = null,
    val code: String? = null,
    val notes: String? = null,
    val isActive: Boolean = true,
)

@Serializable
data class ProductDto(
    val id: String,
    val name: String,
    val sku: String? = null,
    val barcode: String? = null,
    val type: String? = null,
    @Serializable(with = FlexDouble::class) val purchasePrice: Double = 0.0,
    @Serializable(with = FlexDouble::class) val sellingPrice: Double = 0.0,
    @Serializable(with = FlexDouble::class) val stockQuantity: Double = 0.0,
    @Serializable(with = FlexDouble::class) val lowStockThreshold: Double = 0.0,
    val unit: String? = null,
    val isActive: Boolean = true,
    val category: NameDto? = null,
)

@Serializable
data class LineDto(
    @Serializable(with = FlexDouble::class) val quantity: Double = 0.0,
    @Serializable(with = FlexDouble::class) val unitPrice: Double = 0.0,
    @Serializable(with = FlexDouble::class) val unitCost: Double = 0.0,
    @Serializable(with = FlexDouble::class) val lineTotal: Double = 0.0,
    val product: ProductDto? = null,
)

@Serializable
data class PaymentDto(
    @Serializable(with = FlexDouble::class) val amount: Double = 0.0,
    val method: String? = null,
    val direction: String? = null,
    val paidAt: String? = null,
    val receiptNumber: String? = null,
    val status: String? = null,
)

@Serializable
data class SaleDto(
    val id: String,
    val invoiceNumber: String,
    val status: String,
    val paymentStatus: String? = null,
    @Serializable(with = FlexDouble::class) val subtotal: Double = 0.0,
    @Serializable(with = FlexDouble::class) val discount: Double = 0.0,
    @Serializable(with = FlexDouble::class) val tax: Double = 0.0,
    @Serializable(with = FlexDouble::class) val total: Double = 0.0,
    @Serializable(with = FlexDouble::class) val amountPaid: Double = 0.0,
    val paymentMethod: String? = null,
    val createdAt: String? = null,
    val customer: CustomerDto? = null,
    val cashier: NameDto? = null,
    val items: List<LineDto> = emptyList(),
    val payments: List<PaymentDto> = emptyList(),
)

@Serializable
data class PurchaseDto(
    val id: String,
    val purchaseNumber: String,
    val status: String,
    val paymentStatus: String? = null,
    @Serializable(with = FlexDouble::class) val total: Double = 0.0,
    @Serializable(with = FlexDouble::class) val amountPaid: Double = 0.0,
    val createdAt: String? = null,
    val receivedAt: String? = null,
    val supplier: SupplierDto? = null,
    val items: List<LineDto> = emptyList(),
    val payments: List<PaymentDto> = emptyList(),
)

@Serializable
data class PurchaseRequestDto(
    val id: String,
    val requestNumber: String,
    val status: String,
    val notes: String? = null,
    val rejectionReason: String? = null,
    val createdAt: String? = null,
    val requestedBy: NameDto? = null,
    val approvedBy: NameDto? = null,
    val branch: NameDto? = null,
    val items: List<LineDto> = emptyList(),
)

@Serializable
data class PurchaseOrderDto(
    val id: String,
    val poNumber: String,
    val status: String,
    @Serializable(with = FlexDouble::class) val total: Double = 0.0,
    val rejectionReason: String? = null,
    val createdAt: String? = null,
    val supplier: SupplierDto? = null,
    val items: List<LineDto> = emptyList(),
)

@Serializable
data class WarehouseNameDto(val id: String? = null, val name: String? = null)

@Serializable
data class StockTransferDto(
    val id: String,
    val transferNumber: String,
    val status: String,
    val notes: String? = null,
    val rejectionReason: String? = null,
    val createdAt: String? = null,
    val sourceWarehouse: WarehouseNameDto? = null,
    val destinationWarehouse: WarehouseNameDto? = null,
    val items: List<LineDto> = emptyList(),
)

/** GET /customers/:id/history - what the customer bought and paid, and what they still owe. */
@Serializable
data class CustomerHistoryDto(
    val customer: CustomerDto,
    val sales: List<SaleDto> = emptyList(),
    val payments: List<PaymentDto> = emptyList(),
    val balanceDue: Double = 0.0,
)

/** GET /suppliers/:id/ledger - what was bought from the supplier and paid, and what is still owed. */
@Serializable
data class SupplierLedgerDto(
    val supplier: SupplierDto,
    val purchases: List<PurchaseDto> = emptyList(),
    val payments: List<PaymentDto> = emptyList(),
    val balanceDue: Double = 0.0,
)

@Serializable
data class RejectRequest(val reason: String)

@Serializable
class EmptyBody
