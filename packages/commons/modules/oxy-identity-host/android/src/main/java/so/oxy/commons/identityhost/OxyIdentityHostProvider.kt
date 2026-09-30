package so.oxy.commons.identityhost

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import android.util.Log

/**
 * The identity Commons holds, offered to the other Oxy apps without ever
 * handing it out.
 *
 * This is the `AccountManager` model ("Sign in with Google"): the account app
 * keeps the credential, other apps ask it for what they need, and what they get
 * back is a proof or a derived value, never the credential. Commons is the only
 * Oxy app that holds the identity private key; every other app signs in by
 * asking this provider to sign a server challenge.
 *
 * Declared by `plugins/withOxyIdentityHost.js` at `${applicationId}.identity`,
 * behind the `signature`-level `so.oxy.permission.IDENTITY` that every Oxy app
 * declares and requests (`@oxy.so/services/plugins/withOxySharedPermissions`).
 * Inside `call()`, [OxyCallerPolicy] checks again: the caller package (from the
 * Binder, never from the request) must be an allow-listed Oxy app signed with
 * this app's certificate, and each method has its own allow-list.
 *
 * | method              | extras               | answer                                   |
 * |---------------------|----------------------|------------------------------------------|
 * | `describe`          | –                    | `v` (2), `publicKey`                     |
 * | `proveIdentity`     | `challenge` (64 hex) | `publicKey`, `signature`, `timestamp`    |
 * | `deriveScopedSeed`  | `info`               | `seed` (32 bytes hex)                    |
 * | `signSocialReceive` | `index`, `digest`    | `signature` (low-S DER), `publicKey`     |
 *
 * `proveIdentity` builds the whole message itself
 * (`auth:${publicKey}:${challenge}:${timestamp}`, the one `POST /auth/verify`
 * checks), so a caller cannot get an arbitrary message signed.
 *
 * Every refusal and failure is `null`: no identity, a caller that is not
 * allowed, malformed extras. No answer ever carries the private key or a child
 * private key. All CRUD operations are no-ops; only `call()` exists.
 */
class OxyIdentityHostProvider : ContentProvider() {
  override fun onCreate(): Boolean = true

  override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
    val ctx = context ?: return null
    return try {
      val caller = OxyCallerPolicy.resolveCaller(ctx, method) ?: return null
      val (privateKey, publicKey) = IdentitySignerStore.read(ctx) ?: return null
      when (method) {
        METHOD_DESCRIBE -> {
          if (!OxyCallerPolicy.mayDescribe(caller)) return refuse(caller, method)
          Bundle().apply {
            putInt(KEY_VERSION, PROTOCOL_VERSION)
            putString(KEY_PUBLIC_KEY, publicKey)
          }
        }
        METHOD_PROVE_IDENTITY -> {
          if (!OxyCallerPolicy.mayProveIdentity(caller)) return refuse(caller, method)
          val challenge = extras?.getString(KEY_CHALLENGE) ?: return null
          val timestamp = System.currentTimeMillis()
          val signature = IdentityCrypto.proveIdentity(privateKey, publicKey, challenge, timestamp)
          Bundle().apply {
            putString(KEY_PUBLIC_KEY, publicKey)
            putString(KEY_SIGNATURE, signature)
            putLong(KEY_TIMESTAMP, timestamp)
          }
        }
        METHOD_DERIVE_SCOPED_SEED -> {
          val info = extras?.getString(KEY_INFO) ?: return null
          if (!OxyCallerPolicy.mayDeriveScopedSeed(caller, info)) return refuse(caller, method)
          Bundle().apply { putString(KEY_SEED, IdentityCrypto.deriveScopedSeed(privateKey, info)) }
        }
        METHOD_SIGN_SOCIAL_RECEIVE -> {
          if (!OxyCallerPolicy.maySignSocialReceive(caller)) return refuse(caller, method)
          if (extras == null || !extras.containsKey(KEY_INDEX)) return null
          val index = extras.getInt(KEY_INDEX, -1)
          val digest = extras.getString(KEY_DIGEST) ?: return null
          val (signature, childPublicKey) = IdentityCrypto.signSocialReceive(privateKey, index, digest)
          Bundle().apply {
            putString(KEY_SIGNATURE, signature)
            putString(KEY_PUBLIC_KEY, childPublicKey)
          }
        }
        else -> null
      }
    } catch (error: Exception) {
      // Class name only: the message of a crypto failure may echo its input.
      Log.w(TAG, "$method failed: ${error.javaClass.simpleName}")
      null
    }
  }

  private fun refuse(caller: String, method: String): Bundle? {
    Log.w(TAG, "refused $method for $caller")
    return null
  }

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?,
  ): Cursor? = null

  override fun getType(uri: Uri): String? = null

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<out String>?,
  ): Int = 0

  companion object {
    private const val TAG = "OxyIdentityHost"
    const val PROTOCOL_VERSION = 2

    const val METHOD_DESCRIBE = "describe"
    const val METHOD_PROVE_IDENTITY = "proveIdentity"
    const val METHOD_DERIVE_SCOPED_SEED = "deriveScopedSeed"
    const val METHOD_SIGN_SOCIAL_RECEIVE = "signSocialReceive"

    const val KEY_VERSION = "v"
    const val KEY_PUBLIC_KEY = "publicKey"
    const val KEY_SIGNATURE = "signature"
    const val KEY_TIMESTAMP = "timestamp"
    const val KEY_CHALLENGE = "challenge"
    const val KEY_INFO = "info"
    const val KEY_SEED = "seed"
    const val KEY_INDEX = "index"
    const val KEY_DIGEST = "digest"
  }
}
