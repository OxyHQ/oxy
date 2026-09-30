package so.oxy.devicesession

import android.content.Context
import android.content.SharedPreferences
import so.oxy.storage.OxyEncryptedPrefs
import so.oxy.storage.RecoveryPolicy

/**
 * What a read of the shared slot found.
 *
 * THREE outcomes, and the difference between the last two is the entire safety
 * property of this file. An EMPTY slot authorises a write (seed the device
 * session); a slot that could not be READ must authorise nothing, because it may
 * hold a live session belonging to someone still signed in. Collapsing them —
 * which a plain nullable return would do — is how a locked or broken keystore
 * gets mistaken for a fresh device.
 */
internal sealed interface DeviceSessionRead {
  data class Present(val deviceId: String, val deviceSecret: String) : DeviceSessionRead
  object Absent : DeviceSessionRead
  /** [reason] is an exception CLASS NAME only — never a message, never a value. */
  data class Unavailable(val reason: String) : DeviceSessionRead
}

/**
 * The cross-app DeviceSession credential — `deviceId` + `deviceSecret`, and
 * nothing else — in a HOST app's own data directory.
 *
 * This is NOT the identity keypair. Commons holds the self-custody private key
 * that signs identity approvals and cannot be re-created, in its own module and
 * behind its own provider; this file holds an ordinary session credential the
 * server can revoke and any signed-in app can re-publish. They are separate
 * files behind separate providers with separate permissions precisely so an app
 * that only needs a session is never near the key.
 *
 * Every Oxy app has its own UID and its own data directory, so only the hosts
 * (Commons and Accounts) keep this file; [OxyDeviceSessionProvider] is how every
 * other app reads and writes it.
 */
internal object OxyDeviceSessionStore {
  /** One file per host; the other apps reach it through the host's provider. */
  const val PREFS_NAME = "oxy_shared_device_session"
  const val KEY_DEVICE_ID = "deviceId"
  const val KEY_DEVICE_SECRET = "deviceSecret"

  /**
   * [RecoveryPolicy.RebuildFileOnly] — this store must NEVER escalate to a
   * master-key reset.
   *
   * What it holds is DERIVED: every signed-in app re-publishes the credential
   * from its own durable copy, so losing this file costs at most one interactive
   * sign-in on a device that has no other Oxy app installed. A master-key reset
   * would wipe every other encrypted store of this app sharing the alias — in
   * Commons, that includes the identity signer store. Trading an identity copy to
   * save a credential we can simply re-publish is never the right trade, so the
   * escalation is not merely discouraged here, it is unreachable.
   *
   * Consequence worth stating: a stage-1 heal WIPES this file. That surfaces as
   * `Absent`, which is honest — after the wipe the slot really is empty, and the
   * next successful mint in any app re-seeds it.
   */
  private fun prefs(context: Context): SharedPreferences =
    OxyEncryptedPrefs.open(context, PREFS_NAME, RecoveryPolicy.RebuildFileOnly)

  /**
   * Read the credential. A thrown open (the keyset is unreadable and the policy
   * above refuses to escalate) is reported as [DeviceSessionRead.Unavailable] —
   * never as absent.
   */
  fun read(context: Context): DeviceSessionRead =
    runCatching {
      val p = prefs(context)
      val deviceId = p.getString(KEY_DEVICE_ID, null)
      val deviceSecret = p.getString(KEY_DEVICE_SECRET, null)
      if (deviceId.isNullOrEmpty() || deviceSecret.isNullOrEmpty()) {
        DeviceSessionRead.Absent
      } else {
        DeviceSessionRead.Present(deviceId, deviceSecret)
      }
    }.getOrElse { DeviceSessionRead.Unavailable(it.javaClass.simpleName) }

  /**
   * Replace the credential, returning whether a read-back confirmed it landed.
   *
   * The read-back is the contract JS relies on: a fresh install adopts whatever
   * is in this slot, so publishing a value that did not actually persist would
   * send it into a mint that can never succeed.
   *
   * `commit()` (synchronous) so a cross-process reader firing immediately after
   * the write sees the flushed value.
   */
  fun write(context: Context, deviceId: String, deviceSecret: String): Boolean =
    runCatching {
      val p = prefs(context)
      p.edit()
        .putString(KEY_DEVICE_ID, deviceId)
        .putString(KEY_DEVICE_SECRET, deviceSecret)
        .commit()
      p.getString(KEY_DEVICE_ID, null) == deviceId &&
        p.getString(KEY_DEVICE_SECRET, null) == deviceSecret
    }.getOrDefault(false)

  /** Drop the shared credential. Best-effort; safe to call when already empty. */
  fun clear(context: Context) {
    runCatching { prefs(context).edit().clear().commit() }
  }
}
