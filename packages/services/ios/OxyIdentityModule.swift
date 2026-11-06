import ExpoModulesCore
#if !os(tvOS)
import LocalAuthentication
#endif
import Security
#if canImport(UIKit)
import UIKit
#endif

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

    /// This app's OWN access group, `<prefix><bundle id>` (its application
    /// identifier), or `nil` when the keychain refuses it. Apple makes every
    /// app a member of that group whatever `keychain-access-groups` lists, and
    /// no other app can name it, so the SDK keeps the items that are this app's
    /// alone there (its session credential: ADR 0062 D6), as Android keeps them
    /// in the app's own storage.
    ///
    /// The answer is proven, not assumed: a probe item is written into the group
    /// explicitly and the group is returned only when the keychain took it.
    /// `errSecMissingEntitlement` answers `nil` (the SDK keeps the placement this
    /// build had before); any other failure throws and is asked again.
    AsyncFunction("keychainApplicationAccessGroup") { (_ prefix: String) throws -> String? in
      guard let bundleId = Bundle.main.bundleIdentifier, prefix.hasSuffix(".") else {
        return nil
      }
      let group = prefix + bundleId
      let match: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: OxyIdentityModule.probeService,
        kSecAttrAccount as String: "\(bundleId).application-group",
        kSecAttrAccessGroup as String: group,
      ]
      let deleted = SecItemDelete(match as CFDictionary)
      if deleted == errSecMissingEntitlement {
        return nil
      }
      if deleted != errSecSuccess && deleted != errSecItemNotFound {
        throw KeychainProbeException(deleted)
      }

      var add = match
      add[kSecValueData as String] = Data("probe".utf8)
      add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      let added = SecItemAdd(add as CFDictionary, nil)
      if added == errSecMissingEntitlement {
        return nil
      }
      guard added == errSecSuccess else {
        throw KeychainProbeException(added)
      }
      return group
    }

    /// Read one `expo-secure-store` item WITHOUT user interaction (round-5
    /// review R5-9). expo-secure-store's own read tries `<service>:no-auth`,
    /// then `<service>:auth` (an item stored with `requireAuthentication`,
    /// which prompts for Face ID or the passcode), then the legacy `<service>`.
    /// Any app in a shared access group can plant an `:auth` copy there, so
    /// `@oxy.so/core` reads the shared group through this instead: the
    /// `:no-auth` and legacy copies only, with an `LAContext` that refuses
    /// interaction, so an item that needs the user answers `nil` and no prompt
    /// is ever shown. The query matches expo-secure-store's (service, generic
    /// and account attributes). "Not found" answers `nil`; any other status
    /// throws.
    ///
    /// `errSecInteractionNotAllowed` means one of two things, and they must not
    /// be confused (security review R6-13): an item that needs the user (Face
    /// ID: skipped, `nil`), or a LOCKED keychain (the device is locked and the
    /// item is `WhenUnlocked`). A locked keychain is not "absent": answering
    /// `nil` there let Commons' access-group migration settle its one-shot
    /// record while the shared copies it could not see stayed where every Oxy
    /// app can read them. So while protected data is unavailable the read
    /// THROWS, and the caller defers.
    AsyncFunction("readKeychainItemWithoutInteraction") {
      (_ key: String, _ service: String?, _ accessGroup: String) throws -> String? in
      let base = service ?? "app"
      let encodedKey = Data(key.utf8)
      for itemService in ["\(base):no-auth", base] {
        var query: [String: Any] = [
          kSecClass as String: kSecClassGenericPassword,
          kSecAttrService as String: itemService,
          kSecAttrGeneric as String: encodedKey,
          kSecAttrAccount as String: encodedKey,
          kSecAttrAccessGroup as String: accessGroup,
          kSecMatchLimit as String: kSecMatchLimitOne,
          kSecReturnData as String: true,
        ]
        #if !os(tvOS)
        let context = LAContext()
        context.interactionNotAllowed = true
        query[kSecUseAuthenticationContext as String] = context
        #endif
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
          guard let data = item as? Data else { return nil }
          return String(data: data, encoding: .utf8)
        case errSecItemNotFound:
          continue
        case errSecInteractionNotAllowed, errSecAuthFailed:
          if !OxyIdentityModule.protectedDataAvailable() {
            throw KeychainProbeException(errSecInteractionNotAllowed)
          }
          continue
        default:
          throw KeychainProbeException(status)
        }
      }
      return nil
    }

    // Retired keys (Commons protocol 4): iOS reads them from the wallet group
    // directly, like the current key.
    AsyncFunction("listRetiredKeys") { (_ accountId: String?) -> [String: Any]? in
      return nil
    }

    AsyncFunction("deriveRetiredScopedSeed") { (_ info: String, _ publicKey: String, _ accountId: String?) -> [String: String]? in
      return nil
    }

    AsyncFunction("signRetiredSocialReceive") { (_ index: Int, _ digest: String, _ publicKey: String, _ accountId: String?) -> [String: String]? in
      return nil
    }
  }
}

extension OxyIdentityModule {
  /// Whether the keychain's data-protection class keys are available, i.e. the
  /// device is not locked (R6-13). `UIApplication` is main-thread only; module
  /// functions run on a background queue, so the main queue is asked
  /// synchronously (it never waits on this queue). Where UIKit is absent the
  /// answer is `true`: there is no lock state to tell apart.
  static func protectedDataAvailable() -> Bool {
    #if canImport(UIKit) && !os(watchOS)
    if Thread.isMainThread {
      return UIApplication.shared.isProtectedDataAvailable
    }
    return DispatchQueue.main.sync { UIApplication.shared.isProtectedDataAvailable }
    #else
    return true
    #endif
  }
}

internal final class KeychainProbeException: GenericException<OSStatus> {
  override var reason: String {
    "The keychain refused the request (OSStatus \(param))"
  }
}
