package so.oxy.devicesession

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import so.oxy.security.OxyCallerPolicy

/**
 * The device's shared DeviceSession credential, hosted by the HOST apps
 * (Commons and Accounts, prod and dev) at `${applicationId}.devicesession`,
 * declared by the `withSharedDeviceSessionProvider` config plugin behind the
 * `signature`-level `so.oxy.permission.DEVICE_SESSION`.
 *
 * Oxy apps do not share a UID, so each app's files are its own: the credential
 * lives ONCE per host, in the host's own [OxyDeviceSessionStore], and every
 * other app reads and writes it through this provider
 * ([OxyDeviceSessionModule] sweeps and fans out across the hosts).
 *
 * | method  | extras                     | answer                                   |
 * |---------|----------------------------|------------------------------------------|
 * | `read`  | –                          | `status` (+ `deviceId`, `deviceSecret`)  |
 * | `write` | `deviceId`, `deviceSecret` | `ok`: whether a read-back confirmed it   |
 * | `clear` | –                          | `ok`                                     |
 *
 * The manifest permission is necessary but not sufficient: inside `call()`,
 * [OxyCallerPolicy] takes the caller from the Binder (never from the request)
 * and requires an allow-listed Oxy package signed with this app's certificate.
 * Anything else gets `null`.
 *
 * What crosses the boundary is a session credential — ordinary, rotatable and
 * server-revocable — and nothing else. The identity key is not in this app's
 * reach at all: Commons holds it, and answers for it through a different
 * provider, under a different permission. That separation is the point.
 *
 * All standard CRUD operations are no-ops; this provider exists solely for the
 * `call()` channel.
 */
class OxyDeviceSessionProvider : ContentProvider() {
  override fun onCreate(): Boolean = true

  override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
    val ctx = context ?: return null
    if (method != METHOD_READ && method != METHOD_WRITE && method != METHOD_CLEAR) return null
    OxyCallerPolicy.resolveCaller(ctx, "devicesession.$method") ?: return null

    return when (method) {
      METHOD_READ -> readBundle(OxyDeviceSessionStore.read(ctx))
      METHOD_WRITE -> {
        val deviceId = extras?.getString(OxyDeviceSessionStore.KEY_DEVICE_ID)
        val deviceSecret = extras?.getString(OxyDeviceSessionStore.KEY_DEVICE_SECRET)
        val ok = !deviceId.isNullOrEmpty() && !deviceSecret.isNullOrEmpty() &&
          OxyDeviceSessionStore.write(ctx, deviceId, deviceSecret)
        Bundle().apply { putBoolean(KEY_OK, ok) }
      }
      else -> {
        OxyDeviceSessionStore.clear(ctx)
        Bundle().apply { putBoolean(KEY_OK, true) }
      }
    }
  }

  private fun readBundle(read: DeviceSessionRead): Bundle =
    when (read) {
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
    const val METHOD_WRITE = "write"
    const val METHOD_CLEAR = "clear"
    const val KEY_OK = "ok"
    const val KEY_STATUS = "status"
    const val KEY_REASON = "reason"
    const val STATUS_PRESENT = "present"
    const val STATUS_ABSENT = "absent"
    const val STATUS_UNAVAILABLE = "unavailable"
  }
}
