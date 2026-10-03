plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
 namespace = "so.oxy.fixture.host"
 compileSdk = 36
 buildToolsVersion = "35.0.0"
 defaultConfig { applicationId = "so.oxy.accounts.dev"; minSdk = 28; targetSdk = 36; versionCode = 1; versionName = "1519-fixture" }
 signingConfigs { create("fixture") { storeFile = rootProject.file(".signing/allowed.jks"); storePassword = "oxy1519fixture"; keyAlias = "fixture"; keyPassword = "oxy1519fixture" } }
 buildTypes { getByName("debug") { signingConfig = signingConfigs.getByName("fixture") } }
 compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
 kotlinOptions { jvmTarget = "17" }
}
val copyProviderSources by tasks.registering(Sync::class) {
 from(rootProject.file("../../../packages/services/android/src/main/java")) {
  include("so/oxy/devicesession/OxyDeviceSessionProvider.kt", "so/oxy/devicesession/OxyDeviceSessionStore.kt", "so/oxy/security/OxyCallerPolicy.kt", "so/oxy/storage/OxyEncryptedPrefs.kt")
 }
 into(layout.buildDirectory.dir("generated/provider-sources"))
}
android.sourceSets.getByName("main").java.srcDir(layout.buildDirectory.dir("generated/provider-sources"))
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach { dependsOn(copyProviderSources) }
dependencies { implementation("androidx.security:security-crypto:1.1.0-alpha06") }
