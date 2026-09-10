import ExpoModulesCore

/**
 * iOS no-op implementation of the shared Oxy identity bridge.
 *
 * On Apple platforms the cross-app identity share is handled directly by
 * `@oxy.so/core`'s `KeyManager` via the Keychain Access Group
 * (`group.so.oxy.shared`) — there is no ContentProvider equivalent to wrap. So
 * every function here resolves to `nil` / no-op, which makes the JS
 * `loadSharedIdentityBridge()` seam a pass-through on iOS: `KeyManager`'s iOS
 * branches keep using `expo-secure-store` with the keychain group untouched.
 */
public class OxyIdentityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OxyIdentity")

    AsyncFunction("getShared") { () -> [String: String]? in
      return nil
    }

    AsyncFunction("putShared") { (_ privateKey: String, _ publicKey: String) in
      // No-op on iOS: the keychain-access-group path in KeyManager owns writes.
    }

    AsyncFunction("hasShared") { () -> Bool in
      return false
    }

    AsyncFunction("clearShared") { () in
      // No-op on iOS.
    }
  }
}
