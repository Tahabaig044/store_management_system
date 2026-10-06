package com.akvisionflow.owner.core.network

import com.akvisionflow.owner.core.data.TokenStore
import okhttp3.Interceptor
import okhttp3.Response

/**
 * Attaches the stored Bearer token to every outgoing request except login
 * and health, which are called before a session exists. Never trusts the
 * client to decide what it may write - it only carries the token; every
 * authorization decision (role, read-only) is enforced by the backend.
 */
class AuthInterceptor(private val tokenStore: TokenStore) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        val path = original.url.encodedPath
        if (path.endsWith("/auth/login") || path.endsWith("/health")) {
            return chain.proceed(original)
        }

        val token = tokenStore.getToken()
        val request = if (token != null) {
            original.newBuilder().header("Authorization", "Bearer $token").build()
        } else {
            original
        }
        return chain.proceed(request)
    }
}
