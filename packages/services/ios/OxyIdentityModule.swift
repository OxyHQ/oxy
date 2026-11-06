import ExpoModulesCore
import Security

/**
 * iOS side of the Commons identity bridge.
 *
 * On Apple platforms the identity crosses apps through keychain access groups
 * (docs/identity/ios-keychain-access-groups.md): Commons alone holds
 * `<TEAM>.so.oxy.identity`, Commons and the Peable wallet hold
 * `<TEAM>.so.oxy.wallet`, and every Oxy app holds `<TEAM>.group.so.oxy.shared`.
 * `@oxy.so/core`'s `KeyManager` reads them directly; there is no Commons
 * process to call, so every identity function resolves `nil` and
 * `loadCommonsIdentityBridge()` answers "Commons could not help".
 *
 * The one real function is `keychainDefaultAccessGroup`: JavaScript cannot see
 * the entitlements or the team prefix `$(AppIdentifierPrefix)` expands to, and
 * `kSecAttrAccessGroup` must equal an entitlement value exactly.
 */
public class OxyIdentityModule: Module {
  /// The probe item: per app (its account is the bundle id), never a secret.
  private static let probeService = "so.oxy.keychain-probe"

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

    // Organization keys (ADR 0061 D6) are in the keychain groups on iOS too.
    AsyncFunction("describeOrganization") { (_ accountId: String) -> [String: String]? in
      return nil
    }

    AsyncFunction("deriveOrganizationScopedSeed") { (_ info: String, _ accountId: String) -> [String: String]? in
      return nil
    }

    AsyncFunction("signOrganizationSocialReceive") { (_ index: Int, _ digest: String, _ accountId: String) -> [String: String]? in
      return nil
    }

    /// The access group an item written WITHOUT `kSecAttrAccessGroup` lands in:
    /// the first entry of `keychain-access-groups`, team prefix included. Apple
    /// defines that as the app's default group, so it is also how `KeyManager`
    /// learns which holder this binary is (Commons lists the identity group
    /// first, the Peable wallet the wallet group, every other app the shared one).
    ///
    /// Any earlier probe item is deleted first, in every group this app can
    /// reach: one written by a build with different entitlements sits in that
    /// build's default group and would answer for it.
    AsyncFunction("keychainDefaultAccessGroup") { () throws -> String in
      let account = Bundle.main.bundleIdentifier ?? "app"
      let match: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: OxyIdentityModule.probeService,
        kSecAttrAccount as String: account,
      ]
      let deleted = SecItemDelete(match as CFDictionary)
      if deleted != errSecSuccess && deleted != errSecItemNotFound {
        throw KeychainProbeException(deleted)
      }

      var add = match
      add[kSecValueData as String] = Data("probe".utf8)
      add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      add[kSecReturnAttributes as String] = kCFBooleanTrue
      var result: CFTypeRef?
      let added = SecItemAdd(add as CFDictionary, &result)
      guard added == errSecSuccess else {
        throw KeychainProbeException(added)
      }
      guard
        let attributes = result as? [String: Any],
        let group = attributes[kSecAttrAccessGroup as String] as? String
      else {
        throw KeychainProbeException(errSecInternalError)
      }
      return group
    }
  }
}

internal final class KeychainProbeException: GenericException<OSStatus> {
  override var reason: String {
    "The keychain refused the access-group probe (OSStatus \(param))"
  }
}
