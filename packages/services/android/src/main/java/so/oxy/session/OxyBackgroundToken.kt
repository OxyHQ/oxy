package so.oxy.session

/**
 * The outcome of [OxyBackgroundSession.accessToken].
 *
 * Four cases rather than a nullable token, because a background caller must treat
 * them differently and cannot tell them apart from `null`: "the user is signed
 * out" is a final answer to render, while "the network is down" is something to
 * retry, and conflating the two either blanks a widget that should keep its last
 * content or retries something that will never succeed.
 */
sealed interface OxyBackgroundToken {
  /**
   * A usable bearer for [accountId], valid until [expiresAt] (epoch millis).
   *
   * [accountId] is the account the token was minted for, echoed by the server —
   * NOT a local guess. Key any cached content by it and discard content
   * belonging to a different account, so a switch can never render one account's
   * data under another's name.
   *
   * [baseUrl] is the API origin the credential was provisioned against; use it
   * for the subsequent authenticated request rather than a hardcoded host, so a
   * staging/self-hosted app talks to its own backend.
   */
  data class Available(
    val accessToken: String,
    val expiresAt: Long,
    val accountId: String,
    val baseUrl: String,
  ) : OxyBackgroundToken

  /**
   * There is no usable credential and there will not be one until the user opens
   * the app: none was ever provisioned, it expired, or the server revoked it
   * (sign-out, account switch, or the account left this device).
   *
   * FINAL for this run. Render the signed-out state and report success —
   * retrying cannot change the answer. The local record has already been deleted.
   */
  data object SignedOut : OxyBackgroundToken

  /**
   * The mint could not be completed for a reason a later attempt could get past:
   * no network, a timeout, a 5xx, a rate limit, or ANY ambiguous 401.
   *
   * The credential is KEPT. Retry with backoff and keep showing the last known
   * content; do not render a signed-out state, because the user is not signed
   * out. See [OxyBackgroundSessionApi] for why an unrecognised 401 lands here
   * rather than in [SignedOut].
   */
  data class Transient(val cause: Exception) : OxyBackgroundToken

  /**
   * The server answered, but not in a shape this build can read.
   *
   * The credential is KEPT (nothing proves it is bad) but retrying is pointless:
   * the same body would come back. Log it and stop; this means the wire contract
   * moved and the app needs updating.
   */
  data class Malformed(val cause: Exception) : OxyBackgroundToken
}
