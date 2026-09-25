package so.oxy.identity

import android.content.Context
import android.content.SharedPreferences
import so.oxy.storage.OxyEncryptedPrefs
import so.oxy.storage.RecoveryPolicy

/**
 * Shared accessor for the hardware-backed EncryptedSharedPreferences that holds
 * the cross-app Oxy identity keypair.
 *
 * Used by BOTH [OxyIdentityModule] (the JS bridge / local read + write) and
 * [OxyIdentityProvider] (the cross-process read surface) so the store name and
 * the encryption scheme can never drift between the two halves.
 *
 * Opening the file — the single-memoized-instance rule and the two-stage keyset
 * self-heal, both load-bearing and non-obvious — lives in [OxyEncryptedPrefs],
 * which is shared with the background-session store. Read its documentation
 * before changing anything about how this file is opened.
 *
 * One consequence worth restating here: an open can legitimately return an EMPTY
 * file (the self-heal wipes a keyset it cannot read). That is safe for this slot
 * specifically because it is a DERIVED copy — Commons re-populates it from the
 * primary self-custody identity on the next boot (`migrateToSharedIdentity`), and
 * that primary lives in expo-secure-store under a different file and different
 * keystore aliases, untouched by any recovery here.
 */
internal object OxyIdentityStore {
  const val PREFS_NAME = "oxy_shared_identity"
  const val KEY_PRIVATE = "priv"
  const val KEY_PUBLIC = "pub"

  /**
   * [RecoveryPolicy.RebuildFileOnly], like every other store (OxyHQ/oxy#1388).
   * This store used to regenerate the UID-shared androidx master key when its
   * keyset could not be rebuilt, which made every other Oxy app's encrypted prefs
   * unreadable. It never needs to: this slot is a DERIVED copy that Commons
   * re-populates from the primary identity on every launch
   * (`KeyManager.syncSharedIdentity`), so an empty or unavailable slot costs
   * nothing that a relaunch of Commons does not restore.
   */
  private fun prefs(context: Context): SharedPreferences =
    OxyEncryptedPrefs.open(context, PREFS_NAME, RecoveryPolicy.RebuildFileOnly)

  /** Read the stored keypair as (privateKey, publicKey), or null when absent/blank. */
  fun read(context: Context): Pair<String, String>? {
    val p = prefs(context)
    val priv = p.getString(KEY_PRIVATE, null) ?: return null
    val pub = p.getString(KEY_PUBLIC, null) ?: return null
    if (priv.isEmpty() || pub.isEmpty()) return null
    return priv to pub
  }

  fun write(context: Context, priv: String, pub: String) {
    // commit() (synchronous) so a cross-process reader that fires immediately
    // after the write is guaranteed to see the flushed value.
    prefs(context).edit()
      .putString(KEY_PRIVATE, priv)
      .putString(KEY_PUBLIC, pub)
      .commit()
  }

  fun clear(context: Context) {
    prefs(context).edit().clear().commit()
  }
}
