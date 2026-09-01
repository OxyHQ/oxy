package so.oxy.devicesession

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Bundle

/**
 * Cross-process READ surface for the shared DeviceSession credential, declared
 * per-app by the `withSharedDeviceSession` config plugin at authority
 * `${applicationId}.devicesession` behind a `signature`-level permission.
 *
 * The signature check below is belt-and-suspenders on top of that permission:
 * even if the manifest gate were ever misconfigured, a differently-signed caller
 * still gets nothing. Same-signature is the whole trust boundary — an
 * incorrectly-signed app cannot read this slot, and there is no other way in.
 *
 * READ-ONLY across the process boundary, deliberately. A caller may join the
 * device's session; it may not seed or overwrite another app's. Writes happen
 * only in-process via [OxyDeviceSessionModule], against this app's own store.
 *
 * What crosses the boundary is a session credential — never the identity
 * keypair, which lives behind `so.oxy.identity.OxyIdentityProvider` under a
 * different permission. That separation is the point.
 *
 * All standard CRUD operations are no-ops; this provider exists solely for the
 * `call()` channel.
 */
class OxyDeviceSessionProvider : ContentProvider() {
  override fun onCreate(): Boolean = true

  override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
    if (method != METHOD_READ) return null
    val ctx = context ?: return null
    if (!callerSignatureMatches(ctx)) return null

    return when (val read = OxyDeviceSessionStore.read(ctx)) {
      is DeviceSessionRead.Present -> Bundle().apply {
        putString(KEY_STATUS, STATUS_PRESENT)
        putString(OxyDeviceSessionStore.KEY_DEVICE_ID, read.deviceId)
        putString(OxyDeviceSessionStore.KEY_DEVICE_SECRET, read.deviceSecret)
      }
      is DeviceSessionRead.Absent -> Bundle().apply { putString(KEY_STATUS, STATUS_ABSENT) }
      // Reported, not swallowed. A null here would be indistinguishable from
      // "this app has no credential", and the caller would go on to treat the
      // device as fresh.
      is DeviceSessionRead.Unavailable -> Bundle().apply {
        putString(KEY_STATUS, STATUS_UNAVAILABLE)
        putString(KEY_REASON, read.reason)
      }
    }
  }

  /**
   * True when the calling package shares this app's signing certificate. Uses
   * `checkSignatures` (deprecated but still the simplest correct cross-package
   * signature comparison; returns SIGNATURE_MATCH only for same-cert apps).
   */
  private fun callerSignatureMatches(ctx: Context): Boolean {
    val caller = callingPackage ?: return false
    return runCatching {
      @Suppress("DEPRECATION")
      ctx.packageManager.checkSignatures(caller, ctx.packageName) == PackageManager.SIGNATURE_MATCH
    }.getOrDefault(false)
  }

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?
  ): Cursor? = null

  override fun getType(uri: Uri): String? = null

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<out String>?
  ): Int = 0

  companion object {
    const val METHOD_READ = "read"
    const val KEY_STATUS = "status"
    const val KEY_REASON = "reason"
    const val STATUS_PRESENT = "present"
    const val STATUS_ABSENT = "absent"
    const val STATUS_UNAVAILABLE = "unavailable"
  }
}
