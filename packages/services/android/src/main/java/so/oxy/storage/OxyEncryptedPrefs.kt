package so.oxy.storage

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.KeyStore

/**
 * How far [OxyEncryptedPrefs.open] may go to recover a file whose keyset it
 * cannot read.
 *
 * This exists because the callers do NOT have the same stakes, and the last-resort
 * recovery is UID-wide rather than file-local. Every store must therefore state
 * what it is worth: the choice belongs to the data's owner, not to the helper.
 */
internal enum class RecoveryPolicy {
  /**
   * Wipe and rebuild only this file. If that still fails, GIVE UP — propagate the
   * failure and touch nothing shared.
   *
   * The right policy for any store holding DISPOSABLE data, i.e. data some other
   * authority can re-create. "No data" is then a complete, cost-free recovery, and
   * paying for it with a UID-wide key reset would be trading someone else's
   * irreplaceable data for something we can simply ask for again.
   */
  RebuildFileOnly,

  /**
   * Wipe and rebuild this file, and if that still fails, regenerate the UID-shared
   * master key and rebuild again.
   *
   * Only defensible for a store whose loss is ALREADY catastrophic, because the
   * reset invalidates every other Oxy prefs file wrapped by that key (see
   * [OxyEncryptedPrefs]). Do not choose this to make a store more robust — it makes
   * every OTHER store less so.
   */
  RegenerateSharedMasterKey,
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
 * What is NOT shared is how much each caller may destroy to save itself. That is
 * [RecoveryPolicy], and it is a required argument precisely so the difference
 * cannot be inherited by accident.
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
 * Recovery is bounded and has no retry loop:
 *   1. ALWAYS: delete only the affected file (the stale wrapped keyset) and rebuild
 *      against the current master key. This heals the common rotation case without
 *      touching the master key, so other files keep their keysets.
 *   2. ONLY under [RecoveryPolicy.RegenerateSharedMasterKey]: if a fresh keyset
 *      still cannot be built the master key itself is unusable, so delete its
 *      keystore alias to force a new one, wipe the file again, and rebuild.
 *
 * Stage 2 is UID-WIDE COLLATERAL: regenerating the shared master key makes every
 * OTHER Oxy prefs file wrapped by it unreadable, so each of those heals itself via
 * stage 1 on its next open — meaning it DELETES their contents. For a store whose
 * data is re-creatable that is survivable; for the self-custody identity keypair it
 * is not, which is the whole reason a disposable store must never reach stage 2.
 * Under [RecoveryPolicy.RebuildFileOnly] the failure simply propagates, and the
 * `runCatching {}` at every call site degrades to "absent".
 *
 * None of this touches the app's device session, which lives in expo-secure-store
 * under a DISTINCT prefs file ("SecureStore") and DISTINCT keystore aliases
 * ("key_v1"-derived), not the androidx master key.
 */
internal object OxyEncryptedPrefs {
  private const val TAG = "OxyEncryptedPrefs"
  private const val ANDROID_KEYSTORE = "AndroidKeyStore"

  /** Memoized instances, keyed by prefs file name. Guarded by [lock]. */
  private val instances = mutableMapOf<String, SharedPreferences>()
  private val lock = Any()

  /**
   * The process-wide instance for [prefsName], creating (and recovering) it on
   * first use. [recovery] states how much this caller may destroy to get a working
   * file — see [RecoveryPolicy]; there is no default, on purpose.
   *
   * Throws when the file cannot be built within the chosen policy; callers wrap in
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
   * Stage 1: wipe ONLY this file (which holds the stale wrapped keyset) and
   * rebuild against the current master key. Where it goes next is the caller's
   * policy, not this function's decision.
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
      escalateOrGiveUp(appContext, prefsName, recovery, stillCorrupt)
    } catch (stillCorrupt: IOException) {
      escalateOrGiveUp(appContext, prefsName, recovery, stillCorrupt)
    }
  }

  /**
   * The stage-1-failed fork, and the one place the severity difference between
   * callers is decided.
   *
   * [RecoveryPolicy.RebuildFileOnly] rethrows: this file stays unavailable, which
   * its owner can recover from, and no shared key is touched. Anything else would
   * let a disposable store destroy an irreplaceable one.
   */
  private fun escalateOrGiveUp(
    appContext: Context,
    prefsName: String,
    recovery: RecoveryPolicy,
    cause: Exception,
  ): SharedPreferences {
    if (recovery == RecoveryPolicy.RebuildFileOnly) {
      Log.w(
        TAG,
        "'$prefsName' is still unreadable after a file reset. Giving up rather than " +
          "regenerating the UID-shared master key, which would wipe every other Oxy " +
          "store including the self-custody identity. Its owner re-creates it instead.",
        cause
      )
      throw cause
    }
    return regenerateMasterKeyAndRebuild(appContext, prefsName, cause)
  }

  /**
   * Stage 2, reachable ONLY via [RecoveryPolicy.RegenerateSharedMasterKey]: the
   * androidx master key itself is unusable, so delete its keystore alias to force a
   * fresh one, wipe the now-stale file again, and rebuild.
   *
   * See the UID-wide collateral note in [OxyEncryptedPrefs] — this is destructive
   * to every other store sharing the alias. The alias is used ONLY by androidx
   * EncryptedSharedPreferences, so it never touches expo-secure-store's aliases. A
   * throw here propagates to the call-site `runCatching {}`.
   */
  private fun regenerateMasterKeyAndRebuild(
    appContext: Context,
    prefsName: String,
    cause: Exception
  ): SharedPreferences {
    Log.w(
      TAG,
      "keyset for '$prefsName' still unreadable after reset; deleting master key " +
        "'${MasterKey.DEFAULT_MASTER_KEY_ALIAS}' and regenerating: ${cause.message}",
      cause
    )
    KeyStore.getInstance(ANDROID_KEYSTORE).apply {
      load(null)
      if (containsAlias(MasterKey.DEFAULT_MASTER_KEY_ALIAS)) {
        deleteEntry(MasterKey.DEFAULT_MASTER_KEY_ALIAS)
      }
    }
    appContext.deleteSharedPreferences(prefsName)
    return build(appContext, prefsName)
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
