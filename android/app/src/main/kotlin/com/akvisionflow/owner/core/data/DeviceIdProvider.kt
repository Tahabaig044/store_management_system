package com.akvisionflow.owner.core.data

import android.content.Context
import java.util.UUID

/**
 * A stable per-install identifier used as this device's push "token" while
 * no real Firebase Cloud Messaging project exists for this app (see the
 * Phase 3 report for why: FCM requires an external Google account/project
 * this environment cannot create). It is registered with the backend's
 * Push Token Service exactly like a real FCM token would be, so the whole
 * register → alert-detected → notify → dedupe pipeline is real and tested
 * end-to-end; only the very last hop (an actual OS push) is mocked
 * server-side. Swapping in a real FCM token later is a one-line change
 * here, not a pipeline redesign.
 */
interface DeviceIdProvider {
    fun getOrCreateId(): String
}

class AndroidDeviceIdProvider(context: Context) : DeviceIdProvider {
    private val prefs = context.getSharedPreferences("owner_mobile_device_id", Context.MODE_PRIVATE)

    override fun getOrCreateId(): String {
        val existing = prefs.getString(KEY, null)
        if (existing != null) return existing
        val created = "android-${UUID.randomUUID()}"
        prefs.edit().putString(KEY, created).apply()
        return created
    }

    private companion object {
        const val KEY = "device_id"
    }
}

/** Test/fake implementation - no Android dependencies. */
class FakeDeviceIdProvider(private val id: String = "fake-device-id") : DeviceIdProvider {
    override fun getOrCreateId(): String = id
}
