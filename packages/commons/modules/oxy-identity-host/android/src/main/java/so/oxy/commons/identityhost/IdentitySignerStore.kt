package so.oxy.commons.identityhost

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.IOException
import java.security.GeneralSecurityException

/**
 * The Commons-ONLY copy of the identity key that [OxyIdentityHostProvider]
 * signs with.
 *
 * `KeyManager` (in `@oxy.so/core`) keeps the identity in expo-secure-store and
 * writes this copy through the store Commons registers with
 * `KeyManager.setIdentitySignerStore` (`lib/identity-signer`), on every create,
 * import, rotation and restore. The provider only READS it, and never returns it:
 * other apps get the public key, signatures and derivations, never the key.
 *
 * The file lives in Commons' own data directory under Commons' own UID (no Oxy
 * app shares a UID any more), encrypted with Commons' androidx master key.
 *
 * ## One memoized instance (CRITICAL)
 *
 * `EncryptedSharedPreferences.create()` must run at most once per file per
 * process: a second live instance races Tink's keyset load and the next decrypt
 * throws `AEADBadTagException`. The provider (Binder thread) and the JS module
 * both use this file, so the instance is created once, under a lock.
 *
 * ## Organization keys (ADR 0061 D6)
 *
 * Commons may also hold the keys of organizations its person administers. Each
 * is a pair in this same file under `org.<accountId>.priv` / `.pub`, with the
 * same rules: written by `KeyManager` through Commons' JS (`writeOrganization`),
 * read by the provider only for a request naming that account, never returned.
 * Clearing the personal pair leaves them alone.
 *
 * ## The retired key ring
 *
 * A personal key rotation, or an organization key replacement (ADR 0061 D7),
 * leaves coins at addresses derived from the PREVIOUS key. Commons keeps that
 * previous private key here, per scope, under `retired.<scope>.<publicKey>.priv`
 * / `.pub`: `scope` is `personal` or the organization's account id, and
 * `publicKey` is the retired key's lowercase uncompressed public key (130 hex).
 * A retired key is for SPENDING only: the provider derives and signs with it for
 * the wallet when a request names its public key (`keyPublicKey`), and never
 * proves an identity or describes a person with it. Like every other pair here
 * it is written by `KeyManager` through Commons' JS (`writeRetired`) and never
 * returned over IPC. Neither [clear] nor [clearOrganization] drops a ring: those
 * coins still belong to the person, and only an explicit [clearRetired] removes
 * a retired key.
 *
 * ## File-only self-heal
 *
 * A keyset that cannot be unwrapped is fixed by deleting THIS file and building
 * it again, once. The master key and every other Keystore entry are never
 * deleted. After a heal the file is empty, and Commons writes it again from the
 * primary identity on its next launch (`KeyManager.syncSharedIdentity`), and
 * the organization keys from their own slots (`syncOrganizationKeys`). The
 * retired ring has to be rewritten the same way, from `KeyManager`'s own record
 * of each retired key: this file must never be the only copy of one.
 */
internal object IdentitySignerStore {
  private const val TAG = "OxyIdentitySigner"
  const val PREFS_NAME = "oxy_identity_signer"
  private const val KEY_PRIVATE = "priv"
  private const val KEY_PUBLIC = "pub"
  /** Organization keys (ADR 0061 D6) sit in the same file, under their account id. */
  private const val ORGANIZATION_PREFIX = "org."
  /** Retired keys sit in the same file, under their scope and their own public key. */
  private const val RETIRED_PREFIX = "retired."
  /** The scope of the person's own retired keys; an organization's is its account id. */
  const val PERSONAL_SCOPE = "personal"
  private val PUBLIC_KEY = Regex("^04[0-9a-f]{128}$")

  private val lock = Any()
  private var instance: SharedPreferences? = null

  private fun prefs(context: Context): SharedPreferences = synchronized(lock) {
    instance ?: openOrHeal(context.applicationContext).also { instance = it }
  }

  private fun openOrHeal(appContext: Context): SharedPreferences =
    try {
      build(appContext)
    } catch (corrupt: GeneralSecurityException) {
      heal(appContext, corrupt)
    } catch (corrupt: IOException) {
      heal(appContext, corrupt)
    }

  private fun heal(appContext: Context, cause: Exception): SharedPreferences {
    Log.w(TAG, "keyset for '$PREFS_NAME' unreadable; rebuilding this file only", cause)
    appContext.deleteSharedPreferences(PREFS_NAME)
    return build(appContext)
  }

  private fun build(appContext: Context): SharedPreferences {
    val masterKey = MasterKey.Builder(appContext)
      .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
      .build()
    return EncryptedSharedPreferences.create(
      appContext,
      PREFS_NAME,
      masterKey,
      EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
      EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
  }

  /** (privateKey, publicKey), or null when absent, unreadable, or not a matching pair. */
  fun read(context: Context): Pair<String, String>? = runCatching {
    val p = prefs(context)
    val priv = p.getString(KEY_PRIVATE, null)
    val pub = p.getString(KEY_PUBLIC, null)
    if (priv.isNullOrEmpty() || pub.isNullOrEmpty() || !IdentityCrypto.isHealthyPair(priv, pub)) {
      null
    } else {
      IdentityCrypto.canonicalPrivateKey(priv) to pub.lowercase()
    }
  }.getOrNull()

  /** Replace the pair; true only when a read-back confirms it. Refuses a mismatched pair. */
  fun write(context: Context, privateKey: String, publicKey: String): Boolean = runCatching {
    if (!IdentityCrypto.isHealthyPair(privateKey, publicKey)) return@runCatching false
    val priv = IdentityCrypto.canonicalPrivateKey(privateKey)
    val pub = publicKey.lowercase()
    val p = prefs(context)
    // commit() (synchronous) so a provider call right after the write sees it.
    p.edit().putString(KEY_PRIVATE, priv).putString(KEY_PUBLIC, pub).commit()
    p.getString(KEY_PRIVATE, null) == priv && p.getString(KEY_PUBLIC, null) == pub
  }.getOrDefault(false)

  /**
   * Drop the personal pair. Organization pairs are not the person's identity and
   * stay, and so does every retired key ring, the personal one included: a
   * retired key still spends coins the person owns, and only [clearRetired]
   * removes one.
   */
  fun clear(context: Context) {
    runCatching { prefs(context).edit().remove(KEY_PRIVATE).remove(KEY_PUBLIC).commit() }
  }

  /** That organization's (privateKey, publicKey), or null when absent, unreadable, or mismatched. */
  fun readOrganization(context: Context, accountId: String): Pair<String, String>? = runCatching {
    if (!IdentityCrypto.isOrganizationAccountId(accountId)) return@runCatching null
    val p = prefs(context)
    val priv = p.getString(organizationKey(accountId, KEY_PRIVATE), null)
    val pub = p.getString(organizationKey(accountId, KEY_PUBLIC), null)
    if (priv.isNullOrEmpty() || pub.isNullOrEmpty() || !IdentityCrypto.isHealthyPair(priv, pub)) {
      null
    } else {
      IdentityCrypto.canonicalPrivateKey(priv) to pub.lowercase()
    }
  }.getOrNull()

  /** Replace that organization's pair; true only when a read-back confirms it. */
  fun writeOrganization(
    context: Context,
    accountId: String,
    privateKey: String,
    publicKey: String,
  ): Boolean = runCatching {
    if (!IdentityCrypto.isOrganizationAccountId(accountId)) return@runCatching false
    if (!IdentityCrypto.isHealthyPair(privateKey, publicKey)) return@runCatching false
    val priv = IdentityCrypto.canonicalPrivateKey(privateKey)
    val pub = publicKey.lowercase()
    val privName = organizationKey(accountId, KEY_PRIVATE)
    val pubName = organizationKey(accountId, KEY_PUBLIC)
    val p = prefs(context)
    p.edit().putString(privName, priv).putString(pubName, pub).commit()
    p.getString(privName, null) == priv && p.getString(pubName, null) == pub
  }.getOrDefault(false)

  /** Drop that organization's pair; the personal pair and other organizations are untouched. */
  fun clearOrganization(context: Context, accountId: String) {
    if (!IdentityCrypto.isOrganizationAccountId(accountId)) return
    runCatching {
      prefs(context).edit()
        .remove(organizationKey(accountId, KEY_PRIVATE))
        .remove(organizationKey(accountId, KEY_PUBLIC))
        .commit()
    }
  }

  private fun organizationKey(accountId: String, field: String): String =
    "$ORGANIZATION_PREFIX$accountId.$field"

  /** `personal`, or an organization account id ([IdentityCrypto.isOrganizationAccountId]). */
  fun isRetiredScope(scope: String?): Boolean =
    scope == PERSONAL_SCOPE || IdentityCrypto.isOrganizationAccountId(scope)

  /** A lowercase uncompressed SEC1 public key: `04` and 128 lowercase hex. */
  fun isPublicKey(value: String?): Boolean = value != null && PUBLIC_KEY.matches(value)

  /**
   * The retired (privateKey, publicKey) of [scope] whose public key is
   * [publicKey], or null when absent, unreadable, mismatched, or either argument
   * is malformed. Never the scope's current key: that is [read] /
   * [readOrganization].
   */
  fun readRetired(context: Context, scope: String, publicKey: String): Pair<String, String>? = runCatching {
    if (!isRetiredScope(scope) || !isPublicKey(publicKey)) return@runCatching null
    val p = prefs(context)
    val priv = p.getString(retiredKey(scope, publicKey, KEY_PRIVATE), null)
    val pub = p.getString(retiredKey(scope, publicKey, KEY_PUBLIC), null)
    if (priv.isNullOrEmpty() || pub != publicKey || !IdentityCrypto.isHealthyPair(priv, publicKey)) {
      null
    } else {
      IdentityCrypto.canonicalPrivateKey(priv) to publicKey
    }
  }.getOrNull()

  /**
   * Keep [privateKey] in [scope]'s retired ring, under its own [publicKey]; true
   * only when a read-back confirms it. Refuses a malformed scope or public key
   * and a pair that does not match. Writing a key already in the ring rewrites
   * the same entry.
   */
  fun writeRetired(context: Context, scope: String, privateKey: String, publicKey: String): Boolean = runCatching {
    if (!isRetiredScope(scope) || !isPublicKey(publicKey)) return@runCatching false
    if (!IdentityCrypto.isHealthyPair(privateKey, publicKey)) return@runCatching false
    val priv = IdentityCrypto.canonicalPrivateKey(privateKey)
    val privName = retiredKey(scope, publicKey, KEY_PRIVATE)
    val pubName = retiredKey(scope, publicKey, KEY_PUBLIC)
    val p = prefs(context)
    p.edit().putString(privName, priv).putString(pubName, publicKey).commit()
    p.getString(privName, null) == priv && p.getString(pubName, null) == publicKey
  }.getOrDefault(false)

  /**
   * The public keys in [scope]'s retired ring whose entry is a healthy pair,
   * sorted; empty when there are none, the file is unreadable, or the scope is
   * malformed. `getAll()` decrypts every entry of the file, which is a handful.
   */
  fun listRetired(context: Context, scope: String): List<String> = runCatching {
    if (!isRetiredScope(scope)) return@runCatching emptyList<String>()
    val prefix = "$RETIRED_PREFIX$scope."
    val suffix = ".$KEY_PUBLIC"
    val all = prefs(context).all
    all.keys
      .asSequence()
      .filter { it.startsWith(prefix) && it.endsWith(suffix) }
      .map { it.substring(prefix.length, it.length - suffix.length) }
      .filter { publicKey -> isHealthyRetiredEntry(all, scope, publicKey) }
      .distinct()
      .sorted()
      .toList()
  }.getOrDefault(emptyList<String>())

  /** Drop one retired key of [scope]; every other entry of the file is untouched. */
  fun clearRetired(context: Context, scope: String, publicKey: String) {
    if (!isRetiredScope(scope) || !isPublicKey(publicKey)) return
    runCatching {
      prefs(context).edit()
        .remove(retiredKey(scope, publicKey, KEY_PRIVATE))
        .remove(retiredKey(scope, publicKey, KEY_PUBLIC))
        .commit()
    }
  }

  /** Whether [all] holds a well-formed, matching retired pair for [publicKey] in [scope]. */
  private fun isHealthyRetiredEntry(all: Map<String, *>, scope: String, publicKey: String): Boolean {
    if (!isPublicKey(publicKey)) return false
    if (all[retiredKey(scope, publicKey, KEY_PUBLIC)] != publicKey) return false
    val priv = all[retiredKey(scope, publicKey, KEY_PRIVATE)] as? String ?: return false
    return priv.isNotEmpty() && IdentityCrypto.isHealthyPair(priv, publicKey)
  }

  private fun retiredKey(scope: String, publicKey: String, field: String): String =
    "$RETIRED_PREFIX$scope.$publicKey.$field"
}
