package com.akvisionflow.owner.core.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** The one encrypted preferences file (Android Keystore-backed AES-256) holding everything the app keeps at rest. */
internal fun openSecurePrefs(context: Context): SharedPreferences {
    val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()
    return EncryptedSharedPreferences.create(
        context,
        "owner_mobile_secure_prefs",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
}

/**
 * Persists the Owner Mobile session token in an Android Keystore-backed
 * encrypted preferences file. This is the only place the raw token is
 * written to disk - everywhere else in the app it is held only in memory
 * (see SessionRepository) for the lifetime of the process.
 *
 * Not unit-testable on the JVM (EncryptedSharedPreferences requires the
 * real Android Keystore) - correctness here relies on following Android's
 * documented EncryptedSharedPreferences API exactly, plus on-device/
 * emulator verification.
 */
class SecureTokenStore(context: Context) : TokenStore {

    private val prefs: SharedPreferences by lazy { openSecurePrefs(context) }

    override fun getToken(): String? = prefs.getString(KEY_TOKEN, null)

    override fun saveToken(token: String) {
        prefs.edit().putString(KEY_TOKEN, token).apply()
    }

    override fun clear() {
        prefs.edit().remove(KEY_TOKEN).apply()
    }

    private companion object {
        const val KEY_TOKEN = "session_token"
    }
}

/** The session's non-secret half (who, role, permissions, branch scope), encrypted at rest in the same file. */
class SecureSessionContextStore(context: Context) : SessionContextStore {

    private val prefs: SharedPreferences by lazy { openSecurePrefs(context) }

    override fun get(): SessionContext? = sessionContextFromJson(prefs.getString(KEY_CONTEXT, null))

    override fun save(context: SessionContext) {
        prefs.edit().putString(KEY_CONTEXT, context.toJson()).apply()
    }

    override fun clear() {
        prefs.edit().remove(KEY_CONTEXT).apply()
    }

    private companion object {
        const val KEY_CONTEXT = "session_context"
    }
}
