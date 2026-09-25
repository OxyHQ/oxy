package so.oxy.commons.identitybackup

import android.content.Context
import com.google.android.gms.auth.blockstore.Blockstore
import com.google.android.gms.auth.blockstore.BlockstoreClient
import com.google.android.gms.auth.blockstore.DeleteBytesRequest
import com.google.android.gms.auth.blockstore.RetrieveBytesRequest
import com.google.android.gms.auth.blockstore.StoreBytesData
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The self-custody identity's device backup, in Android Block Store
 * (OxyHQ/oxy#1388).
 *
 * Every Oxy app shares the Linux UID `so.oxy.shared`, and clearing the storage of
 * ANY of them wipes the Android Keystore of the whole UID, which takes every
 * keystore-wrapped copy of the identity with it. Block Store data lives in
 * Google Play services' own private storage, scoped to this package and its
 * signing certificate, so that wipe cannot reach it; reading it back is a local
 * call that needs no network.
 *
 * Cloud backup is requested only when Block Store reports that it will be end-
 * to-end encrypted with the device screen lock. Without a screen lock the value
 * stays on this device only.
 *
 * The JS side (`lib/identity-backup`) owns the record format; this module moves
 * one opaque UTF-8 string under one key. Only Commons links it.
 */
class OxyIdentityBackupModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val client: BlockstoreClient
    get() = Blockstore.getClient(context)

  override fun definition() = ModuleDefinition {
    Name("OxyIdentityBackup")

    /** The stored value, or null when nothing is stored under [key]. */
    AsyncFunction("read") { key: String, promise: Promise ->
      val request = RetrieveBytesRequest.Builder().setKeys(listOf(key)).build()
      client.retrieveBytes(request)
        .addOnSuccessListener { response ->
          val bytes = response.blockstoreDataMap[key]?.bytes
          promise.resolve(bytes?.toString(Charsets.UTF_8))
        }
        .addOnFailureListener { error -> promise.reject(ERR_READ, error.message, error) }
    }

    /**
     * Store [value] under [key]. Resolves whether it will also reach Google's
     * end-to-end encrypted cloud backup (false: this device only).
     */
    AsyncFunction("write") { key: String, value: String, promise: Promise ->
      client.isEndToEndEncryptionAvailable()
        .continueWithTask { e2ee ->
          val cloud = e2ee.isSuccessful && e2ee.result == true
          val data = StoreBytesData.Builder()
            .setKey(key)
            .setBytes(value.toByteArray(Charsets.UTF_8))
            .setShouldBackupToCloud(cloud)
            .build()
          client.storeBytes(data).continueWith { stored ->
            if (!stored.isSuccessful) throw stored.exception ?: IllegalStateException("storeBytes failed")
            cloud
          }
        }
        .addOnSuccessListener { cloud -> promise.resolve(cloud) }
        .addOnFailureListener { error -> promise.reject(ERR_WRITE, error.message, error) }
    }

    AsyncFunction("clear") { key: String, promise: Promise ->
      val request = DeleteBytesRequest.Builder().setKeys(listOf(key)).build()
      client.deleteBytes(request)
        .addOnSuccessListener { promise.resolve(null) }
        .addOnFailureListener { error -> promise.reject(ERR_CLEAR, error.message, error) }
    }
  }

  private companion object {
    const val ERR_READ = "ERR_IDENTITY_BACKUP_READ"
    const val ERR_WRITE = "ERR_IDENTITY_BACKUP_WRITE"
    const val ERR_CLEAR = "ERR_IDENTITY_BACKUP_CLEAR"
  }
}
