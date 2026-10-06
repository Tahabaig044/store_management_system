package com.akvisionflow.owner.core.data

import android.content.Context
import android.content.SharedPreferences

/** The last dashboard figures the server gave us for one filter selection, and when. */
data class DashboardSnapshot(val json: String, val savedAt: Long)

/**
 * Keeps the last successful dashboard summary so the app can still show something useful - clearly marked as saved
 * data, with its time - when the device is offline or the server is unreachable. It is a convenience copy of
 * figures the server already computed (nothing is recalculated here), encrypted at rest, and removed the moment the
 * session ends so it can never be shown to the next person to sign in on the device.
 */
interface DashboardSnapshotStore {
    fun get(key: String): DashboardSnapshot?
    fun save(key: String, snapshot: DashboardSnapshot)
    fun clear()
}

class InMemoryDashboardSnapshotStore : DashboardSnapshotStore {
    private val map = mutableMapOf<String, DashboardSnapshot>()
    override fun get(key: String) = map[key]
    override fun save(key: String, snapshot: DashboardSnapshot) { map[key] = snapshot }
    override fun clear() = map.clear()
}

class SecureDashboardSnapshotStore(context: Context) : DashboardSnapshotStore {
    private val prefs: SharedPreferences by lazy { openSecurePrefs(context) }

    override fun get(key: String): DashboardSnapshot? {
        val json = prefs.getString(PREFIX + key, null) ?: return null
        return DashboardSnapshot(json, prefs.getLong(TIME_PREFIX + key, 0L))
    }

    override fun save(key: String, snapshot: DashboardSnapshot) {
        // Only the most recent handful of filter selections are kept.
        val editor = prefs.edit()
        val keys = prefs.all.keys.filter { it.startsWith(PREFIX) }
        if (keys.size >= MAX_ENTRIES && PREFIX + key !in keys) {
            val oldest = keys.minByOrNull { prefs.getLong(TIME_PREFIX + it.removePrefix(PREFIX), 0L) }
            oldest?.let { editor.remove(it).remove(TIME_PREFIX + it.removePrefix(PREFIX)) }
        }
        editor.putString(PREFIX + key, snapshot.json).putLong(TIME_PREFIX + key, snapshot.savedAt).apply()
    }

    override fun clear() {
        val editor = prefs.edit()
        prefs.all.keys.filter { it.startsWith(PREFIX) || it.startsWith(TIME_PREFIX) }.forEach { editor.remove(it) }
        editor.apply()
    }

    private companion object {
        const val PREFIX = "dash_snapshot:"
        const val TIME_PREFIX = "dash_snapshot_at:"
        const val MAX_ENTRIES = 8
    }
}
