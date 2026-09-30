package so.oxy.commons.identityhost

import android.content.Context
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Commons' JS access to [IdentitySignerStore], the copy of the identity key the
 * identity host provider signs with. In-process only: `KeyManager` writes it on
 * every identity change and reads it as a recovery rung. Nothing here crosses a
 * process boundary; [OxyIdentityHostProvider] is the only IPC surface, and it
 * never returns the key.
 *
 * Plain scalars in, a plain `Map` out, never an Expo `Record` (see the note in
 * `so.oxy.session.OxyBackgroundSessionModule` in `@oxy.so/services`).
 */
class OxyIdentitySignerModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("OxyIdentitySigner")

    AsyncFunction("read") {
      IdentitySignerStore.read(context)?.let { (priv, pub) ->
        mapOf("privateKey" to priv, "publicKey" to pub)
      }
    }

    AsyncFunction("write") { privateKey: String, publicKey: String ->
      IdentitySignerStore.write(context, privateKey, publicKey)
    }

    AsyncFunction("clear") {
      IdentitySignerStore.clear(context)
    }
  }
}
