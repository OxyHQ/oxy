package so.oxy.identity

import android.content.Context
import android.net.Uri
import android.os.Bundle
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS bridge to the Oxy identity Commons holds: the client half only.
 *
 * Commons is the ONLY Oxy app that holds the identity private key. Its identity
 * host (a ContentProvider inside Commons, at `${applicationId}.identity`) answers
 * other Oxy apps with the public key, challenge proofs and derived values —
 * never the key, the way apps get tokens from `AccountManager`. This module
 * calls it: the prod authority first, then the dev variant's.
 *
 * The call crosses a process boundary between two UIDs, so it needs the
 * `signature`-level `so.oxy.permission.IDENTITY` (every Oxy app declares and
 * requests it through `withOxySharedPermissions`) and a `<queries>` entry for the
 * authority (same plugin). Commons then checks the caller's package and
 * certificate itself.
 *
 * | JS function                        | Commons method      | resolves                              |
 * |------------------------------------|---------------------|---------------------------------------|
 * | `describe()`                       | `describe`          | `{ v, publicKey }`                    |
 * | `proveIdentity(challenge)`         | `proveIdentity`     | `{ publicKey, signature, timestamp }` |
 * | `deriveScopedSeed(info)`           | `deriveScopedSeed`  | seed hex                              |
 * | `signSocialReceive(index, digest)` | `signSocialReceive` | `{ signature, publicKey }`            |
 *
 * Every failure — Commons not installed, no identity, the caller refused, an
 * exception — resolves `null`, and the JS side (`@oxy.so/protocol`'s
 * `loadCommonsIdentityBridge`) narrows whatever does come back. Plain scalars in,
 * plain `Map`s out; see `so.oxy.session.OxyBackgroundSessionModule` on why this
 * package never uses an Expo `Record`.
 */
class OxyIdentityModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("OxyIdentity")

    AsyncFunction("describe") {
      ask(METHOD_DESCRIBE, null) { bundle ->
        val publicKey = bundle.getString(KEY_PUBLIC_KEY)
        if (publicKey.isNullOrEmpty()) null
        else mapOf(KEY_VERSION to bundle.getInt(KEY_VERSION), KEY_PUBLIC_KEY to publicKey)
      }
    }

    AsyncFunction("proveIdentity") { challenge: String ->
      ask(METHOD_PROVE_IDENTITY, Bundle().apply { putString(KEY_CHALLENGE, challenge) }) { bundle ->
        val publicKey = bundle.getString(KEY_PUBLIC_KEY)
        val signature = bundle.getString(KEY_SIGNATURE)
        val timestamp = bundle.getLong(KEY_TIMESTAMP, 0L)
        if (publicKey.isNullOrEmpty() || signature.isNullOrEmpty() || timestamp <= 0L) null
        else mapOf(
          KEY_PUBLIC_KEY to publicKey,
          KEY_SIGNATURE to signature,
          // A JS number: epoch milliseconds are exact in a double.
          KEY_TIMESTAMP to timestamp.toDouble(),
        )
      }
    }

    AsyncFunction("deriveScopedSeed") { info: String ->
      ask(METHOD_DERIVE_SCOPED_SEED, Bundle().apply { putString(KEY_INFO, info) }) { bundle ->
        bundle.getString(KEY_SEED)?.takeIf { it.isNotEmpty() }
      }
    }

    AsyncFunction("signSocialReceive") { index: Int, digest: String ->
      val extras = Bundle().apply {
        putInt(KEY_INDEX, index)
        putString(KEY_DIGEST, digest)
      }
      ask(METHOD_SIGN_SOCIAL_RECEIVE, extras) { bundle ->
        val signature = bundle.getString(KEY_SIGNATURE)
        val publicKey = bundle.getString(KEY_PUBLIC_KEY)
        if (signature.isNullOrEmpty() || publicKey.isNullOrEmpty()) null
        else mapOf(KEY_SIGNATURE to signature, KEY_PUBLIC_KEY to publicKey)
      }
    }
  }

  /**
   * Call [method] on the first Commons authority that answers, and read the
   * answer with [read]. An authority that is absent, refuses, or throws is
   * skipped; nothing answering is `null`.
   */
  private fun <T> ask(method: String, extras: Bundle?, read: (Bundle) -> T?): T? {
    for (authority in COMMONS_AUTHORITIES) {
      val bundle = runCatching {
        context.contentResolver.call(Uri.parse("content://$authority"), method, null, extras)
      }.getOrNull() ?: continue
      val value = runCatching { read(bundle) }.getOrNull()
      if (value != null) return value
    }
    return null
  }

  companion object {
    private const val METHOD_DESCRIBE = "describe"
    private const val METHOD_PROVE_IDENTITY = "proveIdentity"
    private const val METHOD_DERIVE_SCOPED_SEED = "deriveScopedSeed"
    private const val METHOD_SIGN_SOCIAL_RECEIVE = "signSocialReceive"

    private const val KEY_VERSION = "v"
    private const val KEY_PUBLIC_KEY = "publicKey"
    private const val KEY_CHALLENGE = "challenge"
    private const val KEY_SIGNATURE = "signature"
    private const val KEY_TIMESTAMP = "timestamp"
    private const val KEY_INFO = "info"
    private const val KEY_SEED = "seed"
    private const val KEY_INDEX = "index"
    private const val KEY_DIGEST = "digest"

    /**
     * Commons hosts its identity at "${applicationId}.identity": the prod app
     * first, then the dev variant. Keep in step with `withOxySharedPermissions`'
     * `<queries>`, or Android 11+ package visibility hides the provider.
     */
    private val COMMONS_AUTHORITIES = listOf(
      "so.oxy.commons.identity",
      "so.oxy.commons.dev.identity",
    )
  }
}
