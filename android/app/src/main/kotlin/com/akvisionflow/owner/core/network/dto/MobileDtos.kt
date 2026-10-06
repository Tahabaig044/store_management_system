package com.akvisionflow.owner.core.network.dto

import kotlinx.serialization.Serializable

// These mirror the exact JSON shapes returned by backend/src/modules/mobile/mobile.routes.js.
// Kept as flat, endpoint-specific DTOs rather than one generic envelope,
// since /api/mobile/v1 does not use a single global response wrapper (see
// that file's header comment) - each field here is exactly what the backend
// sends, nothing inferred or duplicated client-side.

@Serializable
data class HealthResponse(
    val status: String,
    val time: String,
    val api: String,
    val version: String,
)

@Serializable
data class LoginRequest(
    val email: String,
    val password: String,
)

@Serializable
data class LoginResponse(
    val token: String,
    val user: OwnerUserDto,
    val tenant: TenantSummaryDto,
    val permissions: PermissionsDto,
    // Phase 4.1: what this session may do and where (absent on a pre-4.1 server).
    val access: AccessDto? = null,
)

@Serializable
data class ProfileResponse(
    val user: OwnerProfileDto,
    val tenant: TenantSummaryDto,
    val branch: BranchSummaryDto? = null,
    val permissions: PermissionsDto,
    val access: AccessDto? = null,
)

/** The session's real role, the catalog permission keys ("RESOURCE:ACTION") it holds, and its branch scope. */
@Serializable
data class AccessDto(
    val role: String,
    val permissions: List<String> = emptyList(),
    val branchRestricted: Boolean = false,
    val branchIds: List<String>? = null,
)

@Serializable
data class ContextResponse(
    val branchRestricted: Boolean = false,
    val companies: List<CompanyDto> = emptyList(),
    val branches: List<BranchContextDto> = emptyList(),
    val defaultBranchId: String? = null,
)

@Serializable
data class CompanyDto(val id: String, val name: String)

@Serializable
data class BranchContextDto(
    val id: String,
    val name: String,
    val code: String? = null,
    val companyId: String? = null,
)

@Serializable
data class OwnerUserDto(
    val id: String,
    val name: String,
    val email: String,
    val role: String,
)

@Serializable
data class OwnerProfileDto(
    val id: String,
    val name: String,
    val email: String,
    val role: String,
    val lastLoginAt: String? = null,
)

@Serializable
data class TenantSummaryDto(
    val id: String,
    val name: String,
    val businessName: String,
    val logoUrl: String? = null,
    val currency: String,
    val timezone: String,
)

@Serializable
data class BranchSummaryDto(
    val id: String,
    val name: String,
)

@Serializable
data class PermissionsDto(
    val readOnly: Boolean,
    val role: String,
    val writesAllowed: List<String> = emptyList(),
)

@Serializable
data class LogoutResponse(
    val message: String,
)
