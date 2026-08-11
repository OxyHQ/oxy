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
 * nothing else.
 *
 * This is NOT the identity keypair. `so.oxy.identity.OxyIdentityStore` holds the
 * self-custody private key that signs identity approvals and cannot be
 * re-created; this file holds an ordinary session credential the server can
 * revoke and any signed-in app can re-publish. They are separate files behind
 * separate providers with separate permissions precisely so an app that only
 * needs a session is never handed the key.
 *
 * Under `android:sharedUserId="so.oxy.shared"` every Oxy app sees ONE data
 * directory, so this file is literally shared between them — that is the primary
 * transport, and [OxyDeviceSessionProvider] extends the same bytes to a
 * same-signature app outside the UID.
 */
internal object OxyDeviceSessionStore {
  /**
   * Global (not package-suffixed) on purpose — the opposite choice from
   * `oxy_background_session`, and for the opposite reason. That store is
   * per-app precisely so one app cannot touch another's widget credential. This
   * one EXISTS to be one value shared by every app in the UID; scoping it per
   * package would give each app its own copy and defeat the whole point.
   */
  const val PREFS_NAME = "oxy_shared_device_session"
  const val KEY_DEVICE_ID = "deviceId"
  const val KEY_DEVICE_SECRET = "deviceSecret"

  /**
   * [RecoveryPolicy.RebuildFileOnly] — this store must NEVER escalate to a
   * UID-shared master-key reset.
   *
   * What it holds is DERIVED: every signed-in app re-publishes the credential
   * from its own durable copy, so losing this file costs at most one interactive
   * sign-in on a device that has no other Oxy app installed. A master-key reset
   * would wipe every other Oxy store sharing the alias — including the
   * self-custody identity keypair, which is IRREPLACEABLE. Trading someone's
   * unrecoverable identity to save a credential we can simply re-publish is never
   * the right trade, so the escalation is not merely discouraged here, it is
   * unreachable.
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
