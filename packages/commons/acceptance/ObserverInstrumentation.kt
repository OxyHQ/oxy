package so.oxy.fixture.identity

import android.app.Activity
import android.app.Instrumentation
import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.os.Process
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest

/** Read-only metadata in this owned app UID. Never returns a key or file content. */
class ObserverInstrumentation : Instrumentation() {
  override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
  override fun onStart() {
    val report = Bundle()
    try {
      val ctx = targetContext
      check(ctx.packageName == "so.oxy.commons.dev") { "Wrong fixture package" }
      check(ctx.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) { "Debug fixture required" }
      val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      report.putStringArrayList("keystoreAliases", ArrayList(store.aliases().toList().sorted()))
      for (name in listOf("oxy_shared_device_session.xml", "oxy_identity_signer.xml", "SecureStore.xml")) {
        val file = File(ctx.applicationInfo.dataDir, "shared_prefs/$name")
        report.putBoolean("${name}_present", file.isFile)
        report.putBoolean("${name}_backupPresent", File(file.path + ".bak").exists())
        if (file.isFile) {
          check(file.length() <= 1048576) { "Fixture file unexpectedly large" }
          val bytes = file.readBytes()
          report.putString("${name}_sha256", MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })
        }
      }
      report.putInt("uid", Process.myUid())
      report.putString("fixtureStatus", "PASS")
      finish(Activity.RESULT_OK, report)
    } catch (error: Throwable) {
      report.putString("fixtureStatus", "FAIL")
      report.putString("errorClass", error.javaClass.simpleName)
      finish(Activity.RESULT_CANCELED, report)
    }
  }
}
