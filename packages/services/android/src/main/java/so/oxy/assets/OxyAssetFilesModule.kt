package so.oxy.assets

import android.net.Uri
import android.os.SystemClock
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

class OxyAssetFilesModule : Module() {
  private val jobs = ConcurrentHashMap<String, AtomicBoolean>()

  override fun definition() = ModuleDefinition {
    Name("OxyAssetFiles")
    Events("hashProgress")
    // Register synchronously so cancellation cannot race an enqueued worker.
    Function("createHash") { id: String ->
      check(jobs.putIfAbsent(id, AtomicBoolean(false)) == null) { "Duplicate hash operation" }
    }
    Function("cancelHash") { id: String -> jobs[id]?.set(true) }
    AsyncFunction("hashAsync") { id: String, uriString: String, expectedSize: Double ->
      val cancelled = jobs[id] ?: error("Unknown hash operation")
      try {
        val uri = Uri.parse(uriString)
        require(uri.scheme == "file" || uri.scheme == "content") { "Expected a local file" }
        val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
        var lastProgress = 0L
        val result = context.contentResolver.openInputStream(uri)?.use { input ->
          streamSha256(input, { cancelled.get() }) { loaded ->
            val now = SystemClock.elapsedRealtime()
            if (now - lastProgress >= 100 || loaded.toDouble() == expectedSize) {
              lastProgress = now
              sendEvent("hashProgress", mapOf("id" to id, "loaded" to loaded.toDouble()))
            }
          }
        } ?: error("Cannot open upload file")
        check(result.second.toDouble() == expectedSize) { "File changed while hashing" }
        result.first
      } finally {
        jobs.remove(id)
      }
    }
    OnDestroy {
      jobs.values.forEach { it.set(true) }
      jobs.clear()
    }
  }
}
