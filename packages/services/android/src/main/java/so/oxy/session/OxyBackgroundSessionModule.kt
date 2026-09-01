package so.oxy.session

import android.content.Context
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS side of the background session credential.
 *
 * JS is the only writer of the credential and native background code is the only
 * consumer, so this bridge is deliberately one-way: put, clear, and a read of the
 * account id (which JS needs to notice that the stored credential belongs to a
 * different account than the one now signed in). There is no `get` — JS has no
 * use for the secret it just wrote, and not exposing it keeps the secret's only
 * reader native.
 *
 * Every function is a no-op-or-null on failure rather than throwing: the app must
 * work identically whether or not background credentials are available, and a
 * keystore hiccup must never break sign-in.
 */
class OxyBackgroundSessionModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("OxyBackgroundSession")

    /**
     * Store (replacing) the credential. Rejects an incomplete or already-expired
     * one rather than persisting something no mint could ever use.
     *
     * ## Five scalars, not a `Record`, and that is not a style choice
     *
     * This took a `Record` and it did not work on a device: every call was rejected
     * with `The 1st argument cannot be cast to type CredentialInput (received class
     * ReadableNativeMap)`, preceded by `Introspectable data is missing for class
     * CredentialInput. Falling back to reflection-based conversion`. The fallback
     * then failed too, so nothing was ever stored — the provision succeeded, the
     * server issued a credential, and the widget stayed signed out forever with only
     * a warning in the log to show for it.
     *
     * The reason is where this package's Kotlin lives: it ships as SOURCE that each
     * consuming app compiles, so the annotation processing that generates a `Record`'s
     * introspection metadata does not necessarily run in the consumer's build. The
     * sibling module in this same library, `OxyIdentityModule`, has always passed
     * plain scalars (`putShared(privateKey, publicKey)`) and has always worked — so
     * scalars are the proven shape here and `CredentialInput` was the only `Record`
     * in the package, i.e. the one untested path.
     *
     * Do not "tidy" these five parameters back into a `Record` without first proving
     * on a real device that a `Record` converts at all in a consumer build. The
     * failure is silent from JS's side: it surfaces as a widget that never signs in.
     *
     * `expiresAt` is epoch MILLIS as a `Double`, already parsed from the server's
     * ISO-8601 string on the JS side — JS has a `Date`, so there is no reason to hand
     * native a string to re-parse. `Double` because that is what a JS number crosses
     * the bridge as; a `Long` parameter would fail to convert for the same family of
     * reason this comment exists.
     */
    AsyncFunction("put") { baseUrl: String,
      deviceId: String,
      secret: String,
      accountId: String,
      expiresAtMs: Double ->
      val expiresAt = expiresAtMs.toLong()
      if (
        baseUrl.isEmpty() ||
        deviceId.isEmpty() ||
        secret.isEmpty() ||
        accountId.isEmpty() ||
        expiresAt <= System.currentTimeMillis()
      ) {
        return@AsyncFunction false
      }
      runCatching {
        OxyBackgroundSessionStore.writeCredential(
          context,
          OxyBackgroundSessionStore.Credential(
            baseUrl = baseUrl,
            deviceId = deviceId,
            secret = secret,
            accountId = accountId,
            expiresAt = expiresAt,
          ),
        )
      }.isSuccess
    }

    /**
     * Drop the credential and any cached token. Called on sign-out and BEFORE an
     * account switch, so the window in which background code could serve the
     * previous account's data is as short as a local write.
     */
    AsyncFunction("clear") {
      runCatching { OxyBackgroundSessionStore.clear(context) }.isSuccess
    }

    /**
     * What is currently stored — the account it belongs to and when it expires
     * (epoch millis) — or null when there is no usable credential.
     *
     * This is what lets JS decide whether to provision at all: a credential for
     * the signed-in account with plenty of life left needs no network call. It
     * deliberately does NOT return the secret; native is its only reader.
     */
    AsyncFunction("peek") {
      val stored = runCatching { OxyBackgroundSessionStore.readCredential(context) }.getOrNull()
        ?: return@AsyncFunction null
      mapOf(
        "accountId" to stored.accountId,
        "expiresAt" to stored.expiresAt.toDouble(),
      )
    }
  }
}
