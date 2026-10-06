# V1 release rules. Minification/resource shrinking is now on for the release build type
# (app/build.gradle.kts); these rules cover the libraries that need explicit keep rules to survive
# R8 - reflection-based serialization, Retrofit's runtime annotation reading, and the encrypted
# storage library's internal crypto engine. Everything else in the app (Compose, Kotlin coroutines,
# AndroidX) ships its own correct consumer rules inside its AAR and needs nothing added here.

# ---- kotlinx.serialization -------------------------------------------------------------------
# The DTOs under core.network.dto are @Serializable; R8 must keep each one's generated $$serializer
# companion (used reflectively at runtime to build the JSON (de)serializer), or requests/responses
# silently fail to parse in a release build despite compiling and passing every JVM unit test (those
# tests never run through R8). This mirrors kotlinx.serialization's own documented consumer rules,
# scoped to this app's package so it does not also hold onto every third-party serializable class.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class com.akvisionflow.owner.**$$serializer { *; }
-keepclassmembers class com.akvisionflow.owner.** {
    *** Companion;
}
-keepclasseswithmembers class com.akvisionflow.owner.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# ---- Retrofit / OkHttp ------------------------------------------------------------------------
# Retrofit reads @GET/@POST/@Body/... annotations on the API service interfaces via reflection at
# call time - obfuscating or stripping them away breaks every endpoint at runtime with no compile
# error. The -dontwarn lines are for OkHttp's optional platform-detection code paths (Conscrypt,
# BouncyCastle, JDK9 modules) that this app never uses but OkHttp still references.
-keepattributes Signature, Exceptions, RuntimeVisibleAnnotations, RuntimeVisibleParameterAnnotations
-keep,allowobfuscation interface com.akvisionflow.owner.core.network.*ApiService
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
-dontwarn org.codehaus.mojo.animal_sniffer.*

# ---- androidx.security (EncryptedSharedPreferences / Tink) -----------------------------------
# Tink (the crypto engine EncryptedSharedPreferences is built on) registers ciphers/key managers by
# class name at runtime; obfuscating those classes makes key wrap/unwrap fail at runtime in a release
# build with no compile-time signal. This is the exact class of bug an R8 change to this app is most
# likely to introduce invisibly, so it is kept deliberately explicit rather than relying only on
# whatever consumer rules the security-crypto AAR bundles.
-keep class com.google.crypto.tink.** { *; }
-keep interface com.google.crypto.tink.** { *; }
-keep class com.google.crypto.tink.proto.** { *; }
-dontwarn com.google.crypto.tink.**
-dontwarn com.google.errorprone.annotations.**
