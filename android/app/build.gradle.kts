import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// V1 release signing. Real credentials never live in this file or in git: they come from
// android/keystore.properties (git-ignored; android/keystore.properties.example documents the format and
// how to generate a keystore). Its absence never breaks debug builds/tests - only an actual release
// assemble/bundle is refused (see the release-signing check below), so a fresh checkout with no keystore
// still builds and tests normally.
val keystorePropertiesFile = rootProject.file("keystore.properties")
val hasKeystoreProperties = keystorePropertiesFile.exists()
val keystoreProperties = Properties().apply {
    if (hasKeystoreProperties) FileInputStream(keystorePropertiesFile).use { load(it) }
}

android {
    namespace = "com.akvisionflow.owner"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.akvisionflow.owner"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // The backend base URL is a build-time config value, not hard-coded in source, so a release build
        // points at the real production API by passing -PapiBaseUrl=... (see the release-config check
        // below, which refuses a release build that omits it rather than silently shipping the emulator
        // default). Debug builds keep defaulting to the emulator loopback with no extra flags needed.
        val mobileBase = (project.findProperty("apiBaseUrl") as String?) ?: "http://10.0.2.2:4000/api/mobile/v1/"
        buildConfigField("String", "API_BASE_URL", "\"$mobileBase\"")
        // The management screens use the existing web endpoints, which live one level up (/api/).
        buildConfigField("String", "API_ROOT_URL", "\"${mobileBase.removeSuffix("mobile/v1/")}\"")
    }

    signingConfigs {
        if (hasKeystoreProperties) {
            create("release") {
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (hasKeystoreProperties) {
                signingConfig = signingConfigs.getByName("release")
            }
            // else: left unsigned at configuration time, but the check below refuses to actually build it.
        }
        debug {
            isDebuggable = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

// Refuses to actually produce a release artifact (APK or AAB) unless it is both signed and pointed at a real
// API, rather than silently shipping an unsigned build or one still wired to the emulator loopback address.
// Debug builds, unit tests and lint are never affected - this only gates assembleRelease/bundleRelease.
val emulatorApiBase = "http://10.0.2.2:4000/api/mobile/v1/"
gradle.taskGraph.whenReady {
    val buildingReleaseArtifact = allTasks.any {
        it.path.startsWith(":app:") && (it.name.startsWith("assembleRelease") || it.name.startsWith("bundleRelease"))
    }
    if (buildingReleaseArtifact) {
        if (!hasKeystoreProperties) {
            throw GradleException(
                "Refusing to build a release artifact: android/keystore.properties is missing, so it would be " +
                    "unsigned. Copy android/keystore.properties.example, generate a keystore, and fill it in " +
                    "(see that file for the exact command)."
            )
        }
        val mobileBase = (project.findProperty("apiBaseUrl") as String?)
        if (mobileBase.isNullOrBlank() || mobileBase == emulatorApiBase) {
            throw GradleException(
                "Refusing to build a release artifact without a real API URL: pass " +
                    "-PapiBaseUrl=https://<your-domain>/api/mobile/v1/ (the emulator-loopback default is not " +
                    "reachable from a real device)."
            )
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.06.00")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.4")
    implementation("androidx.activity:activity-compose:1.9.1")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.navigation:navigation-compose:2.7.7")

    // Networking - Retrofit + OkHttp + kotlinx.serialization for the JSON
    // envelope shapes returned by /api/mobile/v1 (see backend mobile.routes.js).
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-kotlinx-serialization:2.11.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")

    // Secure on-device token storage (Android Keystore-backed).
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")

    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
}
