package com.akvisionflow.owner.core.context

import com.akvisionflow.owner.core.filters.DashboardFilterRepository
import com.akvisionflow.owner.core.network.ApiErrorKind
import com.akvisionflow.owner.core.network.ApiResult
import com.akvisionflow.owner.core.network.ApiResultMapper
import com.akvisionflow.owner.core.network.dto.BranchContextDto
import com.akvisionflow.owner.core.network.dto.CompanyDto
import com.akvisionflow.owner.core.network.dto.ContextResponse
import com.akvisionflow.owner.testutil.FakeMobileApiService
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

class BranchContextRepositoryTest {

    private val json = Json { ignoreUnknownKeys = true }
    private val mapper = ApiResultMapper(json) {}
    private val north = BranchContextDto("b1", "North", "N1", "c1")
    private val south = BranchContextDto("b2", "South", "S1", "c1")

    private fun repo(response: Response<ContextResponse>, filters: DashboardFilterRepository = DashboardFilterRepository()) =
        BranchContextRepository(FakeMobileApiService(contextResponse = response), mapper, filters) to filters

    @Test
    fun `loads the branches and companies the server says this session may use`() = runTest {
        val (r, _) = repo(Response.success(ContextResponse(false, listOf(CompanyDto("c1", "Acme Optical")), listOf(north, south), null)))
        val result = r.load()
        assertTrue(result is ApiResult.Success)
        assertTrue(r.state.value.loaded)
        assertFalse(r.state.value.restricted)
        assertEquals(listOf("North", "South"), r.state.value.branches.map { it.name })
        assertEquals("Acme Optical", r.state.value.companyName(north))
    }

    @Test
    fun `a user limited to one branch is simply working in it - the shared filter is set to it`() = runTest {
        val (r, filters) = repo(Response.success(ContextResponse(true, emptyList(), listOf(north), "b1")))
        r.load()
        assertEquals("b1", filters.filters.value.branchId)
        assertEquals("North", filters.filters.value.branchName)
    }

    @Test
    fun `a branch selection the session may not use is dropped rather than sent to the server`() = runTest {
        val filters = DashboardFilterRepository()
        filters.update { it.copy(branchId = "someone-elses", branchName = "Far") }
        val (r, _) = repo(Response.success(ContextResponse(true, emptyList(), listOf(north, south), null)), filters)
        r.load()
        assertNull(filters.filters.value.branchId)
        assertNull(filters.filters.value.branchName)
    }

    @Test
    fun `a valid selection, and the choice of an unrestricted user, are left alone`() = runTest {
        val filters = DashboardFilterRepository()
        filters.update { it.copy(branchId = "b2", branchName = "South") }
        val (r, _) = repo(Response.success(ContextResponse(false, emptyList(), listOf(north, south), null)), filters)
        r.load()
        assertEquals("b2", filters.filters.value.branchId)
    }

    @Test
    fun `a failed load reports the error and leaves what was known`() = runTest {
        val fail = Response.error<ContextResponse>(500, "{}".toResponseBody("application/json".toMediaType()))
        val (r, _) = repo(fail)
        val result = r.load()
        assertTrue(result is ApiResult.Error)
        assertEquals(ApiErrorKind.SERVER, (result as ApiResult.Error).kind)
        assertFalse(r.state.value.loaded)
    }

    @Test
    fun `clear forgets the context (sign-out)`() = runTest {
        val (r, _) = repo(Response.success(ContextResponse(false, emptyList(), listOf(north), null)))
        r.load()
        r.clear()
        assertFalse(r.state.value.loaded)
        assertTrue(r.state.value.branches.isEmpty())
    }
}
