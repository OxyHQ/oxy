import ExpoModulesCore

/**
 * iOS stub of the Commons identity bridge.
 *
 * On Apple platforms the Oxy identity is shared through the Keychain Access
 * Group `group.so.oxy.shared`, which `@oxy.so/core`'s `KeyManager` reads
 * directly; there is no Commons provider to call. Every function resolves `nil`,
 * so `loadCommonsIdentityBridge()` answers "Commons could not help" and
 * `KeyManager`'s iOS branches keep using the keychain group.
 */
public class OxyIdentityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OxyIdentity")

    AsyncFunction("describe") { () -> [String: String]? in
      return nil
    }

    AsyncFunction("proveIdentity") { (_ challenge: String) -> [String: String]? in
      return nil
    }

    AsyncFunction("deriveScopedSeed") { (_ info: String) -> String? in
      return nil
    }

    AsyncFunction("signSocialReceive") { (_ index: Int, _ digest: String) -> [String: String]? in
      return nil
    }
  }
}
