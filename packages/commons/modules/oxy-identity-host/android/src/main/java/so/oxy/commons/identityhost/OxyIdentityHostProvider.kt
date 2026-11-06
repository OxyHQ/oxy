package so.oxy.commons.identityhost

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
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
 * | method              | extras                                          | answer                                                        |
 * |---------------------|-------------------------------------------------|---------------------------------------------------------------|
 * | `describe`          | `accountId`?                                    | `v` (4), `publicKey`, `accountId`?                            |
 * | `proveIdentity`     | `challenge` (64 hex)                            | `publicKey`, `signature`, `timestamp`                         |
 * | `deriveScopedSeed`  | `info`, `accountId`?, `keyPublicKey`?           | `seed` (32 bytes hex), `accountId`?, `keyPublicKey`?          |
 * | `signSocialReceive` | `index`, `digest`, `accountId`?, `keyPublicKey`? | `signature` (low-S DER), `publicKey`, `accountId`?, `keyPublicKey`? |
 * | `listRetiredKeys`   | `accountId`?                                    | `publicKeys` (string list), `accountId`?                      |
 *
 * `describe`, `deriveScopedSeed`, `signSocialReceive` and `listRetiredKeys`
 * take an `accountId` extra (ADR 0061 D6): the same method over that
 * ORGANIZATION's key, which Commons holds beside the personal one. Its answer
 * echoes `accountId`, so a caller can tell it from a personal answer (a Commons
 * before protocol 3 ignores the extra and answers for the person, without the
 * echo). An organization Commons holds no key for answers `null`, never the
 * personal key. `proveIdentity` is personal only: an organization key signs
 * nobody in.
 *
 * ## Retired keys (protocol 4)
 *
 * After a rotation (or an organization key replacement, ADR 0061 D7) Commons
 * keeps the previous private key in that scope's retired ring
 * ([IdentitySignerStore.readRetired]), because coins still sit at addresses
 * derived from it. `deriveScopedSeed` and `signSocialReceive` take a
 * `keyPublicKey` extra (lowercase uncompressed, 130 hex) that SELECTS the key
 * of the scope (personal, or `accountId`'s) whose public key it is: the current
 * pair when it matches, else the retired entry, else `null` — never the current
 * key in its place. Every answer to a `keyPublicKey` request echoes
 * `keyPublicKey`, so a caller refuses a Commons before protocol 4, which ignores
 * the extra and answers with the current key. A retired key is for spending
 * only: `describe` and `proveIdentity` with `keyPublicKey` answer `null`.
 * `listRetiredKeys` names the scope's retired public keys, minus its current
 * one, for the wallet only. The label check of `deriveScopedSeed` and the
 * wallet-only rule of `signSocialReceive` are the same for every key.
 *
 * `proveIdentity` builds the whole message itself
 * (`auth:${publicKey}:${challenge}:${timestamp}`, the one `POST /auth/verify`
 * checks), so a caller cannot get an arbitrary message signed.
 *
 * Every refusal and failure is `null`: no identity, a caller that is not
 * allowed, malformed extras, a key Commons does not hold. No answer ever
 * carries a private key, current, retired or child. All CRUD operations are
 * no-ops; only `call()` exists.
 */
class OxyIdentityHostProvider : ContentProvider() {
  override fun onCreate(): Boolean = true

  override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
    val ctx = context ?: return null
    return try {
      val caller = OxyCallerPolicy.resolveCaller(ctx, method) ?: return null
      val accountId = extras?.getString(KEY_ACCOUNT_ID)
      if (accountId != null && !IdentityCrypto.isOrganizationAccountId(accountId)) return null
      val keyPublicKey = extras?.getString(KEY_KEY_PUBLIC_KEY)
      if (keyPublicKey != null && !IdentitySignerStore.isPublicKey(keyPublicKey)) return null
      val request = Request(ctx, caller, method, extras, accountId, keyPublicKey)
      val answer = when (method) {
        METHOD_DESCRIBE -> describe(request)
        METHOD_PROVE_IDENTITY -> proveIdentity(request)
        METHOD_DERIVE_SCOPED_SEED -> deriveScopedSeed(request)
        METHOD_SIGN_SOCIAL_RECEIVE -> signSocialReceive(request)
        METHOD_LIST_RETIRED_KEYS -> listRetiredKeys(request)
        else -> null
      } ?: return null
      // The echoes: which scope, and which key of it, this answer is for.
      if (accountId != null) answer.putString(KEY_ACCOUNT_ID, accountId)
      if (keyPublicKey != null) answer.putString(KEY_KEY_PUBLIC_KEY, keyPublicKey)
      answer
    } catch (error: Exception) {
      // Class name only: the message of a crypto failure may echo its input.
      Log.w(TAG, "$method failed: ${error.javaClass.simpleName}")
      null
    }
  }

  /** One validated request: [accountId] and [keyPublicKey] are well-formed when present. */
  private class Request(
    val ctx: Context,
    val caller: String,
    val method: String,
    val extras: Bundle?,
    val accountId: String?,
    val keyPublicKey: String?,
  )

  private fun describe(r: Request): Bundle? {
    if (!OxyCallerPolicy.mayDescribe(r.caller)) return refuse(r.caller, r.method)
    // A retired key describes nobody.
    if (r.keyPublicKey != null) return null
    val (_, publicKey) = currentKey(r) ?: return null
    return Bundle().apply {
      putInt(KEY_VERSION, PROTOCOL_VERSION)
      putString(KEY_PUBLIC_KEY, publicKey)
    }
  }

  private fun proveIdentity(r: Request): Bundle? {
    if (!OxyCallerPolicy.mayProveIdentity(r.caller)) return refuse(r.caller, r.method)
    // Personal and current only: an organization key or a retired key signs nobody in.
    if (r.accountId != null || r.keyPublicKey != null) return null
    val challenge = r.extras?.getString(KEY_CHALLENGE) ?: return null
    val (privateKey, publicKey) = currentKey(r) ?: return null
    val timestamp = System.currentTimeMillis()
    val signature = IdentityCrypto.proveIdentity(privateKey, publicKey, challenge, timestamp)
    return Bundle().apply {
      putString(KEY_PUBLIC_KEY, publicKey)
      putString(KEY_SIGNATURE, signature)
      putLong(KEY_TIMESTAMP, timestamp)
    }
  }

  private fun deriveScopedSeed(r: Request): Bundle? {
    val info = r.extras?.getString(KEY_INFO) ?: return null
    if (!OxyCallerPolicy.mayDeriveScopedSeed(r.caller, info)) return refuse(r.caller, r.method)
    val (privateKey, _) = spendingKey(r) ?: return null
    return Bundle().apply { putString(KEY_SEED, IdentityCrypto.deriveScopedSeed(privateKey, info)) }
  }

  private fun signSocialReceive(r: Request): Bundle? {
    if (!OxyCallerPolicy.maySignSocialReceive(r.caller)) return refuse(r.caller, r.method)
    val extras = r.extras
    if (extras == null || !extras.containsKey(KEY_INDEX)) return null
    val index = extras.getInt(KEY_INDEX, -1)
    val digest = extras.getString(KEY_DIGEST) ?: return null
    val (privateKey, _) = spendingKey(r) ?: return null
    val (signature, childPublicKey) = IdentityCrypto.signSocialReceive(privateKey, index, digest)
    return Bundle().apply {
      putString(KEY_SIGNATURE, signature)
      putString(KEY_PUBLIC_KEY, childPublicKey)
    }
  }

  private fun listRetiredKeys(r: Request): Bundle? {
    if (!OxyCallerPolicy.mayListRetiredKeys(r.caller)) return refuse(r.caller, r.method)
    if (r.keyPublicKey != null) return null
    val current = currentKey(r)?.second
    val retired = IdentitySignerStore.listRetired(r.ctx, scopeOf(r)).filter { it != current }
    return Bundle().apply { putStringArrayList(KEY_PUBLIC_KEYS, ArrayList(retired)) }
  }

  /** The scope's current pair: the person's, or with `accountId` that organization's. */
  private fun currentKey(r: Request): Pair<String, String>? =
    if (r.accountId == null) IdentitySignerStore.read(r.ctx)
    else IdentitySignerStore.readOrganization(r.ctx, r.accountId)

  /**
   * The key a spending request names. Without `keyPublicKey`, the scope's
   * current pair. With it, the scope's key whose public key it is: the current
   * pair when it matches, else that retired entry, else null. Never a different
   * key than the one named.
   */
  private fun spendingKey(r: Request): Pair<String, String>? {
    val named = r.keyPublicKey ?: return currentKey(r)
    val current = currentKey(r)
    if (current != null && current.second == named) return current
    return IdentitySignerStore.readRetired(r.ctx, scopeOf(r), named)?.takeIf { it.second == named }
  }

  private fun scopeOf(r: Request): String = r.accountId ?: IdentitySignerStore.PERSONAL_SCOPE

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
    /**
     * 3: the `accountId` extra (organization keys, ADR 0061 D6).
     * 4: the `keyPublicKey` extra and `listRetiredKeys` (retired keys).
     */
    const val PROTOCOL_VERSION = 4

    const val METHOD_DESCRIBE = "describe"
    const val METHOD_PROVE_IDENTITY = "proveIdentity"
    const val METHOD_DERIVE_SCOPED_SEED = "deriveScopedSeed"
    const val METHOD_SIGN_SOCIAL_RECEIVE = "signSocialReceive"
    const val METHOD_LIST_RETIRED_KEYS = "listRetiredKeys"

    const val KEY_VERSION = "v"
    const val KEY_PUBLIC_KEY = "publicKey"
    const val KEY_SIGNATURE = "signature"
    const val KEY_TIMESTAMP = "timestamp"
    const val KEY_CHALLENGE = "challenge"
    const val KEY_INFO = "info"
    const val KEY_SEED = "seed"
    const val KEY_INDEX = "index"
    const val KEY_DIGEST = "digest"
    const val KEY_ACCOUNT_ID = "accountId"
    const val KEY_KEY_PUBLIC_KEY = "keyPublicKey"
    const val KEY_PUBLIC_KEYS = "publicKeys"
  }
}
