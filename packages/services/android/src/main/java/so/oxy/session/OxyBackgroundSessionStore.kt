package so.oxy.session

import android.content.Context
import android.content.SharedPreferences
import so.oxy.storage.OxyEncryptedPrefs
import so.oxy.storage.RecoveryPolicy

/**
 * On-device storage for the background session credential and the short access
 * token minted from it.
 *
 * Its own EncryptedSharedPreferences file — it never reads or writes the app's
 * device credential (`oxy.auth.v1` in expo-secure-store). That separation is the
 * whole point of the design: `POST /session/device/token` rotates the device
 * secret on every mint and the presented secret dies 60 seconds later, so
 * background code that touched it would be a second writer to a value the JS
 * runtime depends on, and a worker killed between the mint and the local write
 * would sign the user out of the app. Nothing here can do that.
 *
 * WRITERS: JS (via [OxyBackgroundSessionModule], while the app runs) owns the
 * credential; native (via [OxyBackgroundSession]) owns only the cached token.
 * Neither ever rotates the credential — the server does not rotate it either.
 */
internal object OxyBackgroundSessionStore {
  /**
   * Suffix is the hosting app's package name. Oxy apps share the `so.oxy.shared`
   * Android UID (and therefore one data directory), so a single global prefs name
   * would let one app that leaves `backgroundSession` off wipe another app's
   * live credential on launch. Scoping by package keeps each app's widget/sync
   * store independent.
   */
  private const val PREFS_NAME_PREFIX = "oxy_background_session_"

  private fun prefsName(context: Context): String = PREFS_NAME_PREFIX + context.packageName

  private const val KEY_BASE_URL = "baseUrl"
  private const val KEY_DEVICE_ID = "deviceId"
  private const val KEY_SECRET = "secret"
  private const val KEY_ACCOUNT_ID = "accountId"
  private const val KEY_EXPIRES_AT = "expiresAt"

  private const val KEY_TOKEN = "token"
  private const val KEY_TOKEN_EXPIRES_AT = "tokenExpiresAt"
  private const val KEY_TOKEN_ACCOUNT_ID = "tokenAccountId"

  /** The provisioned credential. [expiresAt] is epoch millis. */
  internal data class Credential(
    val baseUrl: String,
    val deviceId: String,
    val secret: String,
    val accountId: String,
    val expiresAt: Long,
  )

  /** A previously minted access token. [expiresAt] is epoch millis. */
  internal data class CachedToken(
    val accessToken: String,
    val expiresAt: Long,
    val accountId: String,
  )

  /**
   * [RecoveryPolicy.RebuildFileOnly] — this store must NEVER escalate to a
   * UID-shared master-key reset.
   *
   * What it holds is disposable: the app re-provisions the credential on its next
   * foreground, so "no credential" is a complete recovery that costs the user
   * nothing (background refreshes render signed out until then). A master-key reset
   * would wipe every other Oxy store sharing the alias — including the self-custody
   * identity keypair, which is IRREPLACEABLE. Trading someone else's unrecoverable
   * data to save data we can simply ask for again is never the right trade, so the
   * escalation is not merely discouraged here, it is unreachable.
   */
  private fun prefs(context: Context): SharedPreferences =
    OxyEncryptedPrefs.open(context, prefsName(context), RecoveryPolicy.RebuildFileOnly)

  /**
   * The stored credential, or null when absent, incomplete, or expired.
   *
   * An expired credential is DELETED on the way out rather than merely ignored:
   * it can never become valid again (only JS can provision, and it will write a
   * fresh one), so leaving it on disk would keep a dead secret at rest for as
   * long as the app went unopened.
   */
  fun readCredential(context: Context): Credential? {
    val p = prefs(context)
    val baseUrl = p.getString(KEY_BASE_URL, null)
    val deviceId = p.getString(KEY_DEVICE_ID, null)
    val secret = p.getString(KEY_SECRET, null)
    val accountId = p.getString(KEY_ACCOUNT_ID, null)
    val expiresAt = p.getLong(KEY_EXPIRES_AT, 0L)
    if (
      baseUrl.isNullOrEmpty() ||
      deviceId.isNullOrEmpty() ||
      secret.isNullOrEmpty() ||
      accountId.isNullOrEmpty() ||
      expiresAt <= 0L
    ) {
      return null
    }
    if (expiresAt <= System.currentTimeMillis()) {
      clear(context)
      return null
    }
    return Credential(baseUrl, deviceId, secret, accountId, expiresAt)
  }

  /**
   * Replace the credential.
   *
   * Clears any cached token in the SAME commit: a token minted for the previous
   * credential must never survive alongside a new one, or a switch could serve
   * the previous account's bearer for up to its remaining lifetime.
   *
   * `commit()` (synchronous) because the very next thing that reads this may be a
   * WorkManager worker on another thread.
   */
  fun writeCredential(context: Context, credential: Credential) {
    prefs(context).edit()
      .putString(KEY_BASE_URL, credential.baseUrl)
      .putString(KEY_DEVICE_ID, credential.deviceId)
      .putString(KEY_SECRET, credential.secret)
      .putString(KEY_ACCOUNT_ID, credential.accountId)
      .putLong(KEY_EXPIRES_AT, credential.expiresAt)
      .remove(KEY_TOKEN)
      .remove(KEY_TOKEN_EXPIRES_AT)
      .remove(KEY_TOKEN_ACCOUNT_ID)
      .commit()
  }

  /** The account the stored credential belongs to, without touching the network. */
  fun readAccountId(context: Context): String? = readCredential(context)?.accountId

  /** Drop the credential AND any cached token. Safe to call when already empty. */
  fun clear(context: Context) {
    prefs(context).edit().clear().commit()
  }

  /**
   * A cached token still worth reusing for [accountId], or null.
   *
   * Rejects a token minted for a DIFFERENT account (defence in depth — writing a
   * credential already clears the cache) and one inside [reuseFloorMs] of its
   * expiry, so a token cannot expire midway through the request it was fetched
   * for.
   */
  fun readToken(context: Context, accountId: String, reuseFloorMs: Long): CachedToken? {
    val p = prefs(context)
    val token = p.getString(KEY_TOKEN, null)
    val tokenAccountId = p.getString(KEY_TOKEN_ACCOUNT_ID, null)
    val expiresAt = p.getLong(KEY_TOKEN_EXPIRES_AT, 0L)
    if (token.isNullOrEmpty() || tokenAccountId.isNullOrEmpty() || expiresAt <= 0L) {
      return null
    }
    if (tokenAccountId != accountId) {
      return null
    }
    if (expiresAt - reuseFloorMs <= System.currentTimeMillis()) {
      return null
    }
    return CachedToken(token, expiresAt, tokenAccountId)
  }

  /**
   * Cache a freshly minted token so sibling workers in the same refresh cycle
   * share one mint instead of one each (which would also burn the per-device rate
   * limit).
   *
   * `apply()` rather than `commit()`: unlike the credential this is a pure
   * optimization, and a lost write only costs one extra mint.
   */
  fun writeToken(context: Context, token: CachedToken) {
    prefs(context).edit()
      .putString(KEY_TOKEN, token.accessToken)
      .putLong(KEY_TOKEN_EXPIRES_AT, token.expiresAt)
      .putString(KEY_TOKEN_ACCOUNT_ID, token.accountId)
      .apply()
  }
}
