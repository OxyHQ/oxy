import CryptoKit
import ExpoModulesCore
import Foundation

public class OxyAssetFilesModule: Module {
  private let lock = NSLock()
  private var jobs: [String: Bool] = [:]

  private func cancelled(_ id: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return jobs[id] != false
  }

  public func definition() -> ModuleDefinition {
    Name("OxyAssetFiles")
    Events("hashProgress")
    Function("createHash") { (id: String) in
      self.lock.lock()
      defer { self.lock.unlock() }
      self.jobs[id] = false
    }
    Function("cancelHash") { (id: String) in
      self.lock.lock()
      defer { self.lock.unlock() }
      if self.jobs[id] != nil { self.jobs[id] = true }
    }
    AsyncFunction("hashAsync") { (id: String, uri: String, expectedSize: Double) -> String in
      defer {
        self.lock.lock()
        self.jobs.removeValue(forKey: id)
        self.lock.unlock()
      }
      guard let url = URL(string: uri), url.isFileURL else {
        throw NSError(domain: "OxyAssetFiles", code: 1, userInfo: [NSLocalizedDescriptionKey: "Expected a local file"])
      }
      let input = try FileHandle(forReadingFrom: url)
      defer { try? input.close() }
      var digest = SHA256()
      var loaded = 0
      var lastProgress = ProcessInfo.processInfo.systemUptime
      while true {
        if self.cancelled(id) {
          throw NSError(domain: "OxyAssetFiles", code: 2, userInfo: [NSLocalizedDescriptionKey: "Upload hash cancelled"])
        }
        let data = try input.read(upToCount: 1024 * 1024) ?? Data()
        if data.isEmpty { break }
        digest.update(data: data)
        loaded += data.count
        let now = ProcessInfo.processInfo.systemUptime
        if now - lastProgress >= 0.1 || Double(loaded) == expectedSize {
          lastProgress = now
          self.sendEvent("hashProgress", ["id": id, "loaded": loaded])
        }
      }
      guard !self.cancelled(id), Double(loaded) == expectedSize else {
        throw NSError(domain: "OxyAssetFiles", code: 3, userInfo: [NSLocalizedDescriptionKey: "Upload cancelled or file changed"])
      }
      return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }.runOnQueue(DispatchQueue.global(qos: .userInitiated))
    OnDestroy {
      self.lock.lock()
      self.jobs.removeAll()
      self.lock.unlock()
    }
  }
}
