package so.oxy.session

import android.content.Context
import android.util.Log
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * How native background code — a WorkManager worker refreshing a home-screen
 * widget, a sync job — authenticates when there is no JS runtime in the process.
 *
 * ## What this is
 *
 * The app, while running, provisions a background credential and hands it to this
 * store (see `OxyBackgroundSessionModule`). Background code then exchanges it for
 * a short access token whenever it needs one. That is the whole surface:
 *
 * ```kotlin
 * when (val token = OxyBackgroundSession.accessToken(applicationContext)) {
 *   is OxyBackgroundToken.Available -> fetch(token.baseUrl, token.accessToken, token.accountId)
 *   is OxyBackgroundToken.SignedOut -> renderSignedOut()          // final; Result.success()
 *   is OxyBackgroundToken.Transient -> Result.retry()             // keep last content
 *   is OxyBackgroundToken.Malformed -> Result.failure()           // wire contract moved
 * }
 * ```
 *
 * ## What it deliberately cannot do
 *
 * It cannot create a session. Only the app, holding a bearer, can provision a
 * credential — so background code can EXTEND a session the user established
 * in-app but can never bootstrap one from nothing.
 *
 * It cannot damage the app's session. It never reads or writes the device
 * credential, and the credential it does use is not rotated by anyone, so a
 * worker killed mid-mint loses nothing. That property is the reason this exists
 * as a separate credential instead of background code simply reading the device
 * secret.
 *
 * It does not narrow authority. The minted token is a FULL user access token:
 * access tokens carry no scopes today, so this yields exactly what the device
 * credential yields while it is valid. The gains are isolation, a bounded
 * lifetime and independent revocability — NOT "read-only". Do not read
 * "background" as a permission boundary.
 *
 * ## Account correctness
 *
 * Every mint is re-authorized server-side against the live device session, so a
 * stale record cannot resurrect a signed-out account. [OxyBackgroundToken.Available.accountId]
 * is the server's answer, not a local guess — key cached content by it and drop
 * content belonging to another account.
 */
object OxyBackgroundSession {
  private const val TAG = "OxyBackgroundSession"

  /**
   * Refuse to reuse a cached token this close to expiry, so it cannot die midway
   * through the request it was fetched for.
   */
  private val TOKEN_REUSE_FLOOR_MS = TimeUnit.SECONDS.toMillis(60)

  /**
   * Serializes mints within a process so several widgets refreshing together make
   * ONE network call and share its result, instead of one call each — which would
   * also burn the server's per-device rate limit. Waiters re-check the cache after
   * acquiring, so only the first actually mints.
   */
  private val mintMutex = Mutex()

  /**
   * A usable access token for the account this device's app last provisioned, or
   * the reason there is not one. Never throws.
   */
  suspend fun accessToken(context: Context): OxyBackgroundToken {
    val appContext = context.applicationContext
    val credential = readCredential(appContext) ?: return OxyBackgroundToken.SignedOut

    cachedToken(appContext, credential)?.let { return it }

    return mintMutex.withLock {
      // Another caller may have minted while this one waited for the lock.
      cachedToken(appContext, credential)?.let { return@withLock it }
      mintLocked(appContext, credential)
    }
  }

  /**
   * The account a background caller is currently provisioned for, without a
   * network call — for keying cached content, or deciding whether cached content
   * belongs to the current account at all. Null when there is no credential.
   */
  fun activeAccountId(context: Context): String? =
    runCatching { OxyBackgroundSessionStore.readAccountId(context.applicationContext) }
      .getOrNull()

  /**
   * Whether a credential is present, so a widget can draw its signed-out state
   * without attempting a fetch. A `true` here is not a promise that the next mint
   * succeeds — the server is still the authority.
   */
  fun hasCredential(context: Context): Boolean = activeAccountId(context) != null

  /**
   * Read the credential, degrading to null on a storage failure.
   *
   * The keystore can be transiently unavailable (direct-boot, a device being
   * upgraded), and [so.oxy.storage.OxyEncryptedPrefs] can legitimately hand back
   * an emptied file after healing an unreadable keyset. Both mean "no credential
   * right now" rather than a crash in a background worker.
   */
  private fun readCredential(appContext: Context): OxyBackgroundSessionStore.Credential? =
    runCatching { OxyBackgroundSessionStore.readCredential(appContext) }
      .onFailure { Log.w(TAG, "background credential store unreadable", it) }
      .getOrNull()

  private fun cachedToken(
    appContext: Context,
    credential: OxyBackgroundSessionStore.Credential,
  ): OxyBackgroundToken.Available? {
    val cached = runCatching {
      OxyBackgroundSessionStore.readToken(appContext, credential.accountId, TOKEN_REUSE_FLOOR_MS)
    }.getOrNull() ?: return null
    return OxyBackgroundToken.Available(
      accessToken = cached.accessToken,
      expiresAt = cached.expiresAt,
      accountId = cached.accountId,
      baseUrl = credential.baseUrl,
    )
  }

  /**
   * Mint and map the outcome. Called with [mintMutex] held.
   *
   * Only [OxyBackgroundSessionApi.MintOutcome.Revoked] — an explicit server
   * verdict — clears the record. Transient and malformed outcomes KEEP it, so a
   * deploy window or a contract change can never sign a user out of their
   * widgets.
   */
  private suspend fun mintLocked(
    appContext: Context,
    credential: OxyBackgroundSessionStore.Credential,
  ): OxyBackgroundToken =
    when (val outcome = OxyBackgroundSessionApi.mint(credential)) {
      is OxyBackgroundSessionApi.MintOutcome.Minted -> {
        runCatching {
          OxyBackgroundSessionStore.writeToken(
            appContext,
            OxyBackgroundSessionStore.CachedToken(
              accessToken = outcome.accessToken,
              expiresAt = outcome.expiresAt,
              accountId = outcome.accountId,
            ),
          )
        }.onFailure {
          // Caching is an optimization; a failure to store costs one extra mint
          // next time and must not fail the token the caller is waiting for.
          Log.w(TAG, "could not cache the minted background token", it)
        }
        OxyBackgroundToken.Available(
          accessToken = outcome.accessToken,
          expiresAt = outcome.expiresAt,
          accountId = outcome.accountId,
          baseUrl = credential.baseUrl,
        )
      }

      OxyBackgroundSessionApi.MintOutcome.Revoked -> {
        Log.i(TAG, "background credential was revoked by the server; clearing it")
        runCatching { OxyBackgroundSessionStore.clear(appContext) }
          .onFailure { Log.w(TAG, "could not clear the revoked background credential", it) }
        OxyBackgroundToken.SignedOut
      }

      is OxyBackgroundSessionApi.MintOutcome.Transient -> {
        Log.w(TAG, "background token mint failed transiently; keeping the credential", outcome.cause)
        OxyBackgroundToken.Transient(outcome.cause)
      }

      is OxyBackgroundSessionApi.MintOutcome.Malformed -> {
        Log.e(TAG, "background token response could not be read; keeping the credential", outcome.cause)
        OxyBackgroundToken.Malformed(outcome.cause)
      }
    }
}
