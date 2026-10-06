package com.akvisionflow.owner.core.data

import com.akvisionflow.owner.core.network.dto.AccessDto
import com.akvisionflow.owner.core.network.dto.LoginResponse
import com.akvisionflow.owner.core.network.dto.OwnerUserDto
import com.akvisionflow.owner.core.network.dto.PermissionsDto
import com.akvisionflow.owner.core.network.dto.TenantSummaryDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionContextTest {

    private fun login(access: AccessDto?) = LoginResponse(
        token = "t",
        user = OwnerUserDto("u1", "Mira Manager", "mira@shop.test", "MANAGER"),
        tenant = TenantSummaryDto("t1", "Shop", "Shop Business", null, "PKR", "Asia/Karachi"),
        permissions = PermissionsDto(readOnly = true, role = "OWNER_MOBILE"),
        access = access,
    )

    @Test
    fun `a session takes its role, permissions and branch scope from the server's access block`() {
        val ctx = SessionContext.from(login(AccessDto("MANAGER", listOf("REPORT:VIEW", "SALE:VIEW"), branchRestricted = true, branchIds = listOf("b1"))))
        assertEquals("MANAGER", ctx.role)
        assertTrue(ctx.can("REPORT:VIEW"))
        assertFalse(ctx.can("USER:CREATE"))
        assertTrue(ctx.branchRestricted)
        assertEquals(listOf("b1"), ctx.branchIds)
        assertEquals("Shop Business", ctx.businessName)
    }

    @Test
    fun `a server that sends no access block gives the session NO permissions - nothing is assumed`() {
        val ctx = SessionContext.from(login(null))
        assertTrue(ctx.permissions.isEmpty())
        assertFalse(ctx.can("REPORT:VIEW"))
    }

    @Test
    fun `a refreshed access replaces the role and grants, so a revoked permission disappears`() {
        val before = SessionContext.from(login(AccessDto("MANAGER", listOf("REPORT:VIEW", "SALE:VIEW"))))
        val after = before.withAccess(AccessDto("MANAGER", listOf("SALE:VIEW")))
        assertFalse(after.can("REPORT:VIEW"))
        assertTrue(after.can("SALE:VIEW"))
        assertTrue(after.canAny("X:Y", "SALE:VIEW"))
    }

    @Test
    fun `the context survives a JSON round trip, and a damaged stored value is treated as no context`() {
        val ctx = SessionContext.from(login(AccessDto("TENANT_ADMIN", listOf("REPORT:VIEW"))))
        assertEquals(ctx, sessionContextFromJson(ctx.toJson()))
        assertNull(sessionContextFromJson("{not json"))
        assertNull(sessionContextFromJson(""))
        assertNull(sessionContextFromJson(null))
    }
}
