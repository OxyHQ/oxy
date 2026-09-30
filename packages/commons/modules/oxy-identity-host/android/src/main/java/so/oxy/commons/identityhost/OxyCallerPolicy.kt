package so.oxy.commons.identityhost

import android.content.Context
import android.content.pm.PackageManager
import android.os.Binder
import android.os.Build
import android.util.Log
import java.security.MessageDigest

/**
 * Who may ask Commons for what.
 *
 * Two checks, both required, on top of the `signature`-level
 * `so.oxy.permission.IDENTITY` the manifest already demands:
 *
 * 1. **The package is an Oxy app** listed in [OXY_PACKAGES]. The caller is taken
 *    from `Binder.getCallingUid()`, never from anything the caller sends.
 * 2. **It is signed with Commons' own certificate**: `hasSigningCertificate`
 *    (SHA-256, API 28+), `checkSignatures` below that.
 *
 * Keep [OXY_PACKAGES] identical to the device-session caller list in
 * `@oxy.so/services` (`so.oxy.devicesession`); a test compares the two.
 */
internal object OxyCallerPolicy {
  private const val TAG = "OxyIdentityHost"

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

  /** The wallet app: the only caller of the money-bearing methods. */
  private val WALLET_PACKAGES: Set<String> = setOf("to.peable.app", "to.peable.app.dev")

  /**
   * The `deriveScopedSeed` labels each package may ask for. A label is a key
   * domain: Peable's wallet seed must never be derivable by another app.
   */
  private val SCOPED_SEED_INFOS: Map<String, Set<String>> = mapOf(
    "to.peable.app" to setOf("peable/faircoin/v1"),
    "to.peable.app.dev" to setOf("peable/faircoin/v1"),
  )

  fun mayDescribe(pkg: String): Boolean = pkg in OXY_PACKAGES

  fun mayProveIdentity(pkg: String): Boolean = pkg in OXY_PACKAGES

  fun mayDeriveScopedSeed(pkg: String, info: String): Boolean =
    SCOPED_SEED_INFOS[pkg]?.contains(info) == true

  fun maySignSocialReceive(pkg: String): Boolean = pkg in WALLET_PACKAGES

  /**
   * The calling package when it is allow-listed and signed like this app, or
   * null. Several packages can share one UID only if they declare a shared user
   * id, which no Oxy app does; the first qualifying one is used either way.
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
