package so.oxy.security

import android.content.Context
import android.content.pm.PackageManager
import android.os.Binder
import android.os.Build
import android.util.Log
import java.security.MessageDigest

/**
 * Which app is calling one of this package's ContentProviders, and whether it
 * is an Oxy app.
 *
 * Oxy Android apps do not share a UID, so every cross-app call crosses a real
 * process and permission boundary. The manifest already demands a
 * `signature`-level permission (`so.oxy.permission.DEVICE_SESSION`); inside
 * `call()` this checks again, because a permission is necessary but not
 * sufficient:
 *
 * 1. **The package is an Oxy app** listed in [OXY_PACKAGES]. The caller is taken
 *    from `Binder.getCallingUid()`, never from anything the caller sends.
 * 2. **It is signed with this app's certificate**: `hasSigningCertificate`
 *    (SHA-256, API 28+), `checkSignatures` below that.
 *
 * Keep [OXY_PACKAGES] identical to the identity host's list in Commons
 * (`modules/oxy-identity-host`, `OxyCallerPolicy.kt`); a test compares them.
 */
internal object OxyCallerPolicy {
  private const val TAG = "OxyCallerPolicy"

  val OXY_PACKAGES: Set<String> = setOf(
    "earth.mention.app",
    "earth.mention.app.dev",
    "onl.alia.app",
    "onl.alia.app.dev",
    "com.allo.app",
    "com.allo.app.dev",
    "com.homiio.android",
    "com.homiio.android.dev",
    "so.oxy.crowdsource",
    "so.oxy.crowdsource.dev",
    "to.peable.app",
    "to.peable.app.dev",
    "so.oxy.atlas",
    "so.oxy.atlas.dev",
    "to.goway.app",
    "to.goway.app.dev",
    "so.oxy.move",
    "so.oxy.move.dev",
    "sh.willo.app",
    "sh.willo.app.dev",
    "now.moovo.app",
    "now.moovo.app.dev",
    "now.moovo.go",
    "now.moovo.go.dev",
    "now.moovo.tracker",
    "now.moovo.tracker.dev",
    "now.moovo.hub",
    "now.moovo.hub.dev",
    "so.oxy.noted",
    "so.oxy.noted.dev",
    "so.oxy.accounts",
    "so.oxy.accounts.dev",
    "so.oxy.commons",
    "so.oxy.commons.dev",
  )

  /**
   * The calling package when it is allow-listed and signed like this app, or
   * null (logged with the package names and the method only, never a value).
   */
  fun resolveCaller(context: Context, method: String): String? {
    val pm = context.packageManager
    val uid = Binder.getCallingUid()
    val packages = runCatching { pm.getPackagesForUid(uid) }.getOrNull().orEmpty()
    val caller = packages.firstOrNull { it in OXY_PACKAGES && signedLikeSelf(context, it) }
    if (caller == null) {
      Log.w(TAG, "refused $method for ${packages.joinToString().ifEmpty { "uid $uid" }}")
    }
    return caller
  }

  private fun signedLikeSelf(context: Context, pkg: String): Boolean = runCatching {
    val pm = context.packageManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      val info = pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
      val signers = info.signingInfo?.apkContentsSigners.orEmpty()
      signers.isNotEmpty() && signers.any { signer ->
        val digest = MessageDigest.getInstance("SHA-256").digest(signer.toByteArray())
        pm.hasSigningCertificate(pkg, digest, PackageManager.CERT_INPUT_SHA256)
      }
    } else {
      @Suppress("DEPRECATION")
      pm.checkSignatures(pkg, context.packageName) == PackageManager.SIGNATURE_MATCH
    }
  }.getOrDefault(false)
}
