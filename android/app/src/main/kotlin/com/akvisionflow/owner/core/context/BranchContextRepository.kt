package com.akvisionflow.owner.core.context

import com.akvisionflow.owner.core.filters.DashboardFilterRepository
import com.akvisionflow.owner.core.network.ApiResult
import com.akvisionflow.owner.core.network.ApiResultMapper
import com.akvisionflow.owner.core.network.MobileApiService
import com.akvisionflow.owner.core.network.dto.BranchContextDto
import com.akvisionflow.owner.core.network.dto.CompanyDto
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The company/branch context of the signed-in session: which branches exist for them, grouped by company. */
data class BranchContext(
    val loaded: Boolean = false,
    val restricted: Boolean = false,
    val companies: List<CompanyDto> = emptyList(),
    val branches: List<BranchContextDto> = emptyList(),
    val defaultBranchId: String? = null,
) {
    fun branch(id: String?): BranchContextDto? = branches.firstOrNull { it.id == id }
    fun companyName(branch: BranchContextDto): String? = companies.firstOrNull { it.id == branch.companyId }?.name
}

/**
 * Loads the branches this session may work in (the server applies the existing branch/company scope) and keeps
 * the shared dashboard filter consistent with them: a branch selection the user is not allowed to use is
 * dropped, and a user limited to exactly one branch is simply working in it.
 */
class BranchContextRepository(
    private val api: MobileApiService,
    private val resultMapper: ApiResultMapper,
    private val filters: DashboardFilterRepository,
) {
    private val _state = MutableStateFlow(BranchContext())
    val state: StateFlow<BranchContext> = _state.asStateFlow()

    suspend fun load(): ApiResult<BranchContext> {
        val result = resultMapper.execute { api.context() }
        if (result is ApiResult.Error) return result
        val data = (result as ApiResult.Success).data
        val ctx = BranchContext(true, data.branchRestricted, data.companies, data.branches, data.defaultBranchId)
        _state.value = ctx
        filters.update { f ->
            val selected = f.branchId
            when {
                selected != null && ctx.branch(selected) == null -> f.copy(branchId = null, branchName = null)
                selected == null && ctx.defaultBranchId != null -> f.copy(branchId = ctx.defaultBranchId, branchName = ctx.branch(ctx.defaultBranchId)?.name)
                else -> f
            }
        }
        return ApiResult.Success(ctx)
    }

    fun clear() {
        _state.value = BranchContext()
    }
}
