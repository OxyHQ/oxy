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
 * ## File-only self-heal
 *
 * A keyset that cannot be unwrapped is fixed by deleting THIS file and building
 * it again, once. The master key and every other Keystore entry are never
 * deleted. After a heal the file is empty, and Commons writes it again from the
 * primary identity on its next launch (`KeyManager.syncSharedIdentity`).
 */
internal object IdentitySignerStore {
  private const val TAG = "OxyIdentitySigner"
  const val PREFS_NAME = "oxy_identity_signer"
  private const val KEY_PRIVATE = "priv"
  private const val KEY_PUBLIC = "pub"

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

  fun clear(context: Context) {
    runCatching { prefs(context).edit().clear().commit() }
  }
}
