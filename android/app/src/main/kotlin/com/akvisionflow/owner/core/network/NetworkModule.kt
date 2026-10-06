package com.akvisionflow.owner.core.network

import android.content.Context
import com.akvisionflow.owner.BuildConfig
import com.akvisionflow.owner.core.data.SessionRepository
import com.akvisionflow.owner.core.data.TokenStore
import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import okhttp3.Cache
import okhttp3.CacheControl
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

/**
 * Builds the shared Retrofit/OkHttp stack. Kept as plain factory functions
 * rather than a DI framework - Phase 1 has exactly one API surface and a
 * handful of screens, so a dependency-injection library would add more
 * ceremony than it removes; this can grow into Hilt later without changing
 * any call site's shape.
 *
 * Performance/caching foundation (Phase 1 requirement): GET responses are
 * cached to disk via OkHttp's standard HTTP cache, and served stale for a
 * short window when the network is unavailable, so re-opening a screen
 * (e.g. Profile) doesn't always force a round trip.
 */
object NetworkModule {

    private const val CACHE_SIZE_BYTES = 5L * 1024 * 1024
    // explicitNulls = false: an UpdateNotificationPreferencesRequest field
    // left null (unset) is omitted from the request body entirely, rather
    // than serialized as a JSON `null` the backend's zod .optional() (not
    // .nullable()) schema would reject.
    @OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; explicitNulls = false }

    fun provideJson(): Json = json

    fun provideOkHttpClient(context: Context, tokenStore: TokenStore): OkHttpClient {
        val cache = Cache(File(context.cacheDir, "http_cache"), CACHE_SIZE_BYTES)

        val loggingInterceptor = HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) HttpLoggingInterceptor.Level.BASIC else HttpLoggingInterceptor.Level.NONE
        }

        // Personal and business records (customers, suppliers, sales...) are never written to the on-disk HTTP cache:
        // only the mobile dashboard/profile responses may be. (The cache is also wiped when a session ends.)
        val noStoreForManagement = Interceptor { chain ->
            val response = chain.proceed(chain.request())
            if (isManagementPath(chain.request().url.encodedPath)) response.newBuilder().header("Cache-Control", "no-store").removeHeader("Expires").build() else response
        }

        val offlineCacheInterceptor = Interceptor { chain ->
            var request = chain.request()
            request = request.newBuilder()
                .cacheControl(CacheControl.Builder().maxStale(1, TimeUnit.MINUTES).build())
                .build()
            chain.proceed(request)
        }

        return OkHttpClient.Builder()
            .cache(cache)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .addInterceptor(AuthInterceptor(tokenStore))
            .addInterceptor(loggingInterceptor)
            // Only used when the live request actually fails to reach the
            // network transport (see MobileApiService callers); it never
            // masks a fresh 401/403 from a reachable backend.
            .addNetworkInterceptor(noStoreForManagement)
            .addNetworkInterceptor(offlineCacheInterceptor)
            .build()
    }

    /** True for the existing web endpoints the management screens use (everything except the mobile-only API). */
    fun isManagementPath(encodedPath: String): Boolean = !encodedPath.contains("/mobile/v1/")

    private fun buildRetrofit(client: OkHttpClient, baseUrl: String = BuildConfig.API_BASE_URL): Retrofit {
        val contentType = "application/json".toMediaType()
        return Retrofit.Builder()
            .baseUrl(baseUrl)
            .client(client)
            .addConverterFactory(json.asConverterFactory(contentType))
            .build()
    }

    fun provideApiService(client: OkHttpClient): MobileApiService = buildRetrofit(client).create(MobileApiService::class.java)

    fun provideManageApiService(client: OkHttpClient): ManageApiService = buildRetrofit(client, BuildConfig.API_ROOT_URL).create(ManageApiService::class.java)

    fun provideDashboardApiService(client: OkHttpClient): DashboardApiService = buildRetrofit(client).create(DashboardApiService::class.java)

    fun provideAlertsApiService(client: OkHttpClient): AlertsApiService = buildRetrofit(client).create(AlertsApiService::class.java)

    fun provideAiAdvisorApiService(client: OkHttpClient): AiAdvisorApiService = buildRetrofit(client).create(AiAdvisorApiService::class.java)

    fun provideResultMapper(sessionRepository: SessionRepository): ApiResultMapper =
        ApiResultMapper(json) { sessionRepository.onUnauthorized() }
}
