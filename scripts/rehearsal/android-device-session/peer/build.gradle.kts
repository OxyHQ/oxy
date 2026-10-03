plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
 namespace = "so.oxy.fixture.peer"
 compileSdk = 36
 buildToolsVersion = "35.0.0"
 defaultConfig { applicationId = "earth.mention.app.dev"; minSdk = 28; targetSdk = 36; versionCode = 1; versionName = "1519-fixture" }
 signingConfigs { create("fixture") { storeFile = rootProject.file(".signing/allowed.jks"); storePassword = "oxy1519fixture"; keyAlias = "fixture"; keyPassword = "oxy1519fixture" } }
 buildTypes { getByName("debug") { signingConfig = signingConfigs.getByName("fixture") } }
 compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
 kotlinOptions { jvmTarget = "17" }
}
android.sourceSets.getByName("main").java.srcDir(rootProject.file("probe-src"))
