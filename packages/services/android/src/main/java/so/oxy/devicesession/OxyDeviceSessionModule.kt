package so.oxy.devicesession

import android.content.Context
import android.net.Uri
import android.os.Bundle
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS bridge for the shared DeviceSession credential.
 *
 * - `read` resolves the credential this DEVICE holds, from the sibling providers
 *   first and this app's own store second (see [readShared] for why that order).
 * - `write` publishes into this app's own store only, and reports whether a
 *   read-back confirmed it.
 * - `clear` drops this app's copy.
 *
 * ## `read` returns a STATUS, not a nullable value
 *
 * The three answers "here it is", "there is none" and "I could not tell" are
 * genuinely different, and only the second one authorises the JS side to seed the
 * slot. A nullable return would merge the last two, and the merged value reads as
 * "fresh device" — which is exactly how a locked or broken keystore ends up
 * overwriting a live session. So every path here reports its status explicitly,
 * and never degrades a failure into an absence.
 *
 * Return shapes:
 * ```
 * { "status": "present", "deviceId": "...", "deviceSecret": "..." }
 * { "status": "absent" }
 * { "status": "unavailable", "reason": "<ExceptionClassName>" }
 * ```
 *
 * Plain scalars in, a plain `Map` out — never an Expo `Record`. This package
 * ships as SOURCE that each consuming app compiles, so the annotation processing
 * a `Record` needs to become introspectable does not necessarily run in the
 * consumer's build; the one `Record` this package ever had failed to convert on a
 * real device and stored nothing, silently. See the long note in
 * `so.oxy.session.OxyBackgroundSessionModule` before reaching for one here.
 */
class OxyDeviceSessionModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("OxyDeviceSession")

    AsyncFunction("read") {
      readShared()
    }

    AsyncFunction("write") { deviceId: String, deviceSecret: String ->
      if (deviceId.isEmpty() || deviceSecret.isEmpty()) {
        return@AsyncFunction false
      }
      OxyDeviceSessionStore.write(context, deviceId, deviceSecret)
    }

    AsyncFunction("clear") {
      OxyDeviceSessionStore.clear(context)
    }
  }

  /**
   * Providers FIRST, this app's own store second.
   *
   * Under `android:sharedUserId="so.oxy.shared"` every Oxy app sees one data
   * directory, so for a UID member the local file IS the group's file and the
   * order changes nothing. It matters for a same-signature app OUTSIDE the UID:
   * there the local file is a private mirror of whatever that app itself last
   * wrote, so reading it first would shadow the group's real credential forever.
   *
   * `unavailable` is sticky across the whole sweep: if ANY source could not be
   * read and none produced a credential, the answer is `unavailable`, not
   * `absent`. The pessimistic merge is the point — the optimistic one authorises
   * a write.
   */
  private fun readShared(): Map<String, String> {
    var unavailableReason: String? = null

    for (authority in PROVIDER_AUTHORITIES) {
      when (val read = callProvider(authority)) {
        is DeviceSessionRead.Present -> return present(read)
        is DeviceSessionRead.Unavailable -> unavailableReason = unavailableReason ?: read.reason
        // Absent, or no provider there at all (not installed, refused, threw) —
        // neither is evidence about the other sources, so keep looking.
        else -> Unit
      }
    }

    when (val local = OxyDeviceSessionStore.read(context)) {
      is DeviceSessionRead.Present -> return present(local)
      is DeviceSessionRead.Unavailable -> unavailableReason = unavailableReason ?: local.reason
      is DeviceSessionRead.Absent -> Unit
    }

    val reason = unavailableReason
    return if (reason != null) {
      mapOf(
        OxyDeviceSessionProvider.KEY_STATUS to OxyDeviceSessionProvider.STATUS_UNAVAILABLE,
        OxyDeviceSessionProvider.KEY_REASON to reason,
      )
    } else {
      mapOf(OxyDeviceSessionProvider.KEY_STATUS to OxyDeviceSessionProvider.STATUS_ABSENT)
    }
  }

  private fun present(read: DeviceSessionRead.Present): Map<String, String> = mapOf(
    OxyDeviceSessionProvider.KEY_STATUS to OxyDeviceSessionProvider.STATUS_PRESENT,
    OxyDeviceSessionStore.KEY_DEVICE_ID to read.deviceId,
    OxyDeviceSessionStore.KEY_DEVICE_SECRET to read.deviceSecret,
  )

  /**
   * Call one sibling provider. `null` means "nothing to learn from this one" —
   * the app is not installed, package visibility hid it, the permission was
   * refused, or the call threw. A provider that answered but could not read its
   * own store returns [DeviceSessionRead.Unavailable], which the sweep keeps.
   */
  private fun callProvider(authority: String): DeviceSessionRead? = runCatching {
    val uri = Uri.parse("content://$authority")
    val bundle: Bundle = context.contentResolver.call(
      uri,
      OxyDeviceSessionProvider.METHOD_READ,
      null,
      null,
    ) ?: return@runCatching null

    when (bundle.getString(OxyDeviceSessionProvider.KEY_STATUS)) {
      OxyDeviceSessionProvider.STATUS_PRESENT -> {
        val deviceId = bundle.getString(OxyDeviceSessionStore.KEY_DEVICE_ID)
        val deviceSecret = bundle.getString(OxyDeviceSessionStore.KEY_DEVICE_SECRET)
        if (deviceId.isNullOrEmpty() || deviceSecret.isNullOrEmpty()) {
          // A `present` verdict with an incomplete payload is a broken peer, not
          // an empty device.
          DeviceSessionRead.Unavailable("IncompleteProviderPayload")
        } else {
          DeviceSessionRead.Present(deviceId, deviceSecret)
        }
      }
      OxyDeviceSessionProvider.STATUS_ABSENT -> DeviceSessionRead.Absent
      OxyDeviceSessionProvider.STATUS_UNAVAILABLE ->
        DeviceSessionRead.Unavailable(
          bundle.getString(OxyDeviceSessionProvider.KEY_REASON) ?: "PeerUnavailable",
        )
      // An older sibling that predates this protocol. It said something we do not
      // understand, so we have learned nothing — never read that as "absent".
      else -> DeviceSessionRead.Unavailable("UnrecognisedProviderStatus")
    }
  }.getOrNull()

  companion object {
    /**
     * Sibling authorities to sweep, in order. Each official Oxy Android app hosts
     * the provider at `${applicationId}.devicesession` via the
     * `withSharedDeviceSession` config plugin, and both the prod and `.dev`
     * variants are listed so a developer build can join a device too.
     *
     * MAINTAINED LIST, and the constraint on it is specific: every entry must be
     * an app inside the `so.oxy.shared` UID. UID members all serve ONE file, so
     * the sweep is deterministic no matter which of them answers first. Adding an
     * app that is same-signature but NOT in the UID would put a second,
     * independent copy of "the shared credential" into the sweep and make the
     * winner depend on list order.
     *
     * The same authorities must also be added to the `<queries>` block in
     * `withSharedDeviceSession.js`, or Android 11+ package-visibility filtering
     * hides them from `ContentResolver.call` and the sweep silently finds nothing.
     */
    private val PROVIDER_AUTHORITIES = listOf(
      "so.oxy.accounts.devicesession",
      "so.oxy.accounts.dev.devicesession",
      "so.oxy.commons.devicesession",
      "so.oxy.commons.dev.devicesession",
    )
  }
}
