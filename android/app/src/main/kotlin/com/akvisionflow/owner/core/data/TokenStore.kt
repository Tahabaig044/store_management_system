package com.akvisionflow.owner.core.data

/**
 * Abstraction over where the session token lives, so ViewModels/repositories
 * can be unit-tested against [InMemoryTokenStore] without touching the
 * Android Keystore. The real app uses [SecureTokenStore].
 */
interface TokenStore {
    fun getToken(): String?
    fun saveToken(token: String)
    fun clear()
}

/** Test/fake implementation - no Android dependencies. */
class InMemoryTokenStore(initial: String? = null) : TokenStore {
    private var token: String? = initial
    override fun getToken(): String? = token
    override fun saveToken(token: String) {
        this.token = token
    }
    override fun clear() {
        token = null
    }
}
