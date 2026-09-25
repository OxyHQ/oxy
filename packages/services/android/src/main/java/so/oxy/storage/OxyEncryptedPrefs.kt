package so.oxy.storage

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.IOException
import java.security.GeneralSecurityException

/**
 * How far [OxyEncryptedPrefs.open] may go to recover a file whose keyset it
 * cannot read.
 *
 * There is exactly one answer now: rebuild this file, and if that fails, give up.
 * The enum stays a required argument so every store keeps stating it at its
 * call site, where a reviewer sees it.
 *
 * It used to have a second value, `RegenerateSharedMasterKey`, which deleted the
 * androidx master key (`_androidx_security_master_key_`) when a rebuild failed.
 * That key is ONE Keystore entry for the whole `so.oxy.shared` UID and wraps the
 * keyset of every Oxy prefs file in every Oxy app, so deleting it let one app
 * make every sibling's encrypted prefs unreadable. It was removed for
 * OxyHQ/oxy#1388 and must not come back: no store in any Oxy app deletes a
 * UID-shared key.
 */
internal enum class RecoveryPolicy {
  /**
   * Wipe and rebuild only this file. If that still fails, GIVE UP — propagate the
   * failure and touch nothing shared. Every caller degrades to "absent" and its
   * owner re-creates the data (see each store for who that is).
   */
  RebuildFileOnly,
}

/**
 * The ONE way this package opens a hardware-backed [EncryptedSharedPreferences]
 * file.
 *
 * Two stores are built on it — the cross-app identity keypair
 * (`so.oxy.identity.OxyIdentityStore`) and the background session credential
 * (`so.oxy.session.OxyBackgroundSessionStore`) — and both need the same two
 * non-obvious properties below. They are implemented once here rather than per
 * store: a second copy would be a copy of exactly the reasoning that is easiest
 * to get wrong, and the failure mode of getting it wrong is silent (every read
 * degrades to "absent" with no exception at the call site).
 *
 * Each caller still names its [RecoveryPolicy] at the call site. There is only
 * one policy, and it never touches a key another app depends on.
 *
 * ## One memoized instance per file (CRITICAL)
 *
 * `EncryptedSharedPreferences.create()` must be called AT MOST ONCE per file per
 * process. It is NOT safe to re-instantiate: when a second instance is created
 * for the same file while another is live (e.g. a JS write thread and a Binder
 * thread, or a WorkManager worker and the app's main thread), Tink's keyset load
 * races and the next decrypt throws `AEADBadTagException` — which silently turned
 * every cross-app read into "no shared identity". So instances are created once,
 * lazily, under a lock, keyed by file name on the process-global application
 * context, and reused for every subsequent read/write.
 *
 * The cache is keyed by file name ALONE, which is correct because each file has
 * exactly one owning store and therefore exactly one policy. Two callers opening
 * the same file with different policies would be a bug in the callers, not
 * something this cache should try to reconcile.
 *
 * ## Keyset self-heal (CRITICAL)
 *
 * The androidx master key that wraps each file's Tink keyset lives under the
 * UID-scoped default alias [MasterKey.DEFAULT_MASTER_KEY_ALIAS] — ONE entry for
 * the whole `so.oxy.shared` UID. When a NEW package joins that shared UID, that
 * master key can be rotated/regenerated, leaving keysets already written on disk
 * wrapped under the OLD key. `create()` then fails GCM verification
 * (`AEADBadTag` -> `GeneralSecurityException`, or an unreadable keyset ->
 * `IOException`) on EVERY read/write, and `EncryptedSharedPreferences` never
 * self-heals — the slot stays permanently dead.
 *
 * Recovery is bounded and has no retry loop: delete only the affected file (the
 * stale wrapped keyset) and rebuild against the current master key. This heals
 * the rotation case without touching the master key, so other files keep their
 * keysets. If a fresh keyset still cannot be built, the failure propagates and
 * the `runCatching {}` at every call site degrades to "absent".
 *
 * The master key itself is NEVER deleted here. It is shared by the whole UID, so
 * deleting it would make every other Oxy app's prefs file unreadable (and each
 * would then wipe itself on its next open). When the master key is gone — the
 * Keystore of the UID was wiped because some Oxy app's storage was cleared —
 * androidx creates a new one on the next `MasterKey.Builder.build()` and each
 * file heals itself through the file-only rebuild above. What was IN those
 * files is lost with the Keystore either way; for the self-custody identity,
 * the keystore-independent device backup brings it back (docs/identity/device-backup.md).
 *
 * None of this touches the app's device session, which lives in expo-secure-store
 * under a DISTINCT prefs file ("SecureStore") and DISTINCT keystore aliases
 * ("key_v1"-derived), not the androidx master key.
 */
internal object OxyEncryptedPrefs {
  private const val TAG = "OxyEncryptedPrefs"

  /** Memoized instances, keyed by prefs file name. Guarded by [lock]. */
  private val instances = mutableMapOf<String, SharedPreferences>()
  private val lock = Any()

  /**
   * The process-wide instance for [prefsName], creating (and recovering) it on
   * first use. [recovery] is stated by every caller — see [RecoveryPolicy]; there
   * is no default, on purpose.
   *
   * Throws when the file cannot be built after a file-only rebuild; callers wrap in
   * `runCatching {}` and degrade to "absent".
   */
  fun open(context: Context, prefsName: String, recovery: RecoveryPolicy): SharedPreferences {
    synchronized(lock) {
      instances[prefsName]?.let { return it }
      val appContext = context.applicationContext
      return openOrHeal(appContext, prefsName, recovery).also { instances[prefsName] = it }
    }
  }

  private fun openOrHeal(
    appContext: Context,
    prefsName: String,
    recovery: RecoveryPolicy,
  ): SharedPreferences {
    return try {
      build(appContext, prefsName)
    } catch (corrupt: GeneralSecurityException) {
      healKeyset(appContext, prefsName, recovery, corrupt)
    } catch (corrupt: IOException) {
      healKeyset(appContext, prefsName, recovery, corrupt)
    }
  }

  /**
   * Wipe ONLY this file (which holds the stale wrapped keyset) and rebuild
   * against the current master key.
   */
  private fun healKeyset(
    appContext: Context,
    prefsName: String,
    recovery: RecoveryPolicy,
    cause: Exception,
  ): SharedPreferences {
    Log.w(
      TAG,
      "keyset for '$prefsName' unreadable (rotated master key); cleared and regenerated: ${cause.message}",
      cause
    )
    appContext.deleteSharedPreferences(prefsName)
    return try {
      build(appContext, prefsName)
    } catch (stillCorrupt: GeneralSecurityException) {
      giveUp(prefsName, recovery, stillCorrupt)
    } catch (stillCorrupt: IOException) {
      giveUp(prefsName, recovery, stillCorrupt)
    }
  }

  /**
   * The file is still unreadable after a file reset. Give up: this file stays
   * unavailable, which its owner recovers from, and no shared key is touched.
   */
  private fun giveUp(prefsName: String, recovery: RecoveryPolicy, cause: Exception): Nothing {
    Log.w(
      TAG,
      "'$prefsName' is still unreadable after a file reset ($recovery). Giving up " +
        "without touching the UID-shared master key; its owner re-creates it.",
      cause
    )
    throw cause
  }

  private fun build(appContext: Context, prefsName: String): SharedPreferences {
    val masterKey = MasterKey.Builder(appContext)
      .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
      .build()
    return EncryptedSharedPreferences.create(
      appContext,
      prefsName,
      masterKey,
      EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
      EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )
  }
}
