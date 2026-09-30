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
 * The credential lives in the HOST apps only — Commons and Accounts, prod and
 * dev ([HOST_AUTHORITIES]) — each in its own [OxyDeviceSessionStore]. Oxy apps
 * do not share a UID, so no app can see another's files; everything else goes
 * through the hosts' [OxyDeviceSessionProvider]:
 *
 * - `read` sweeps the hosts in [HOST_AUTHORITIES] order, Commons first, and
 *   returns the first credential it finds. A host reads ITSELF from its own
 *   store instead of calling its own provider.
 * - `write` publishes to EVERY reachable host (itself locally, the others
 *   through their providers), so the hosts hold the same credential, and
 *   reports whether at least one read-back confirmed it.
 * - `clear` drops the credential from every reachable host.
 *
 * An app that is not a host keeps no copy of its own: with no host installed
 * there is no shared credential, which the sweep reports as `absent`.
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
      publish(deviceId, deviceSecret)
    }

    AsyncFunction("clear") {
      clearShared()
    }
  }

  /** This app's own provider authority; a host when it is in [HOST_AUTHORITIES]. */
  private val selfAuthority: String
    get() = "${context.packageName}$AUTHORITY_SUFFIX"

  /**
   * The hosts in [HOST_AUTHORITIES] order; this app, if it is one, from its own
   * store. Every app sweeps the same list in the same order, so they all adopt
   * the same credential.
   *
   * `unavailable` is sticky across the whole sweep: if ANY source could not be
   * read and none produced a credential, the answer is `unavailable`, not
   * `absent`. The pessimistic merge is the point — the optimistic one authorises
   * a write.
   */
  private fun readShared(): Map<String, String> {
    var unavailableReason: String? = null

    for (authority in HOST_AUTHORITIES) {
      val read = if (authority == selfAuthority) OxyDeviceSessionStore.read(context) else callProvider(authority)
      when (read) {
        is DeviceSessionRead.Present -> return present(read)
        is DeviceSessionRead.Unavailable -> unavailableReason = unavailableReason ?: read.reason
        // Absent, or no provider there at all (not installed, refused, threw) —
        // neither is evidence about the other sources, so keep looking.
        else -> Unit
      }
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

  /**
   * Write the credential to every reachable host. True when at least one of them
   * confirmed it by read-back: that host is now what every app's sweep adopts,
   * or the next one down if an earlier host holds another credential.
   */
  private fun publish(deviceId: String, deviceSecret: String): Boolean {
    var confirmed = false
    for (authority in HOST_AUTHORITIES) {
      val ok = if (authority == selfAuthority) {
        OxyDeviceSessionStore.write(context, deviceId, deviceSecret)
      } else {
        callWrite(authority, deviceId, deviceSecret)
      }
      confirmed = confirmed || ok
    }
    return confirmed
  }

  /** Drop the credential from every reachable host. Best-effort. */
  private fun clearShared() {
    for (authority in HOST_AUTHORITIES) {
      if (authority == selfAuthority) {
        OxyDeviceSessionStore.clear(context)
      } else {
        runCatching {
          context.contentResolver.call(
            Uri.parse("content://$authority"),
            OxyDeviceSessionProvider.METHOD_CLEAR,
            null,
            null,
          )
        }
      }
    }
  }

  /** One host's `write`; false when it is absent, refused, or did not confirm. */
  private fun callWrite(authority: String, deviceId: String, deviceSecret: String): Boolean = runCatching {
    val extras = Bundle().apply {
      putString(OxyDeviceSessionStore.KEY_DEVICE_ID, deviceId)
      putString(OxyDeviceSessionStore.KEY_DEVICE_SECRET, deviceSecret)
    }
    context.contentResolver
      .call(Uri.parse("content://$authority"), OxyDeviceSessionProvider.METHOD_WRITE, null, extras)
      ?.getBoolean(OxyDeviceSessionProvider.KEY_OK, false) == true
  }.getOrDefault(false)

  private fun present(read: DeviceSessionRead.Present): Map<String, String> = mapOf(
    OxyDeviceSessionProvider.KEY_STATUS to OxyDeviceSessionProvider.STATUS_PRESENT,
    OxyDeviceSessionStore.KEY_DEVICE_ID to read.deviceId,
    OxyDeviceSessionStore.KEY_DEVICE_SECRET to read.deviceSecret,
  )

  /**
   * Call one host's `read`. `null` means "nothing to learn from this one" —
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
      // A status this build does not know. It said something we do not
      // understand, so we have learned nothing — never read that as "absent".
      else -> DeviceSessionRead.Unavailable("UnrecognisedProviderStatus")
    }
  }.getOrNull()

  companion object {
    private const val AUTHORITY_SUFFIX = ".devicesession"

    /**
     * The hosts, in sweep order: Commons, then Accounts, each prod before dev.
     * Each hosts [OxyDeviceSessionProvider] at `${applicationId}.devicesession`
     * through the `withSharedDeviceSessionProvider` config plugin.
     *
     * The same authorities must be in the `<queries>` of
     * `withOxySharedPermissions.js`, or Android 11+ package visibility hides
     * them from `ContentResolver.call` and the sweep silently finds nothing.
     */
    private val HOST_AUTHORITIES = listOf(
      "so.oxy.commons.devicesession",
      "so.oxy.commons.dev.devicesession",
      "so.oxy.accounts.devicesession",
      "so.oxy.accounts.dev.devicesession",
    )
  }
}
