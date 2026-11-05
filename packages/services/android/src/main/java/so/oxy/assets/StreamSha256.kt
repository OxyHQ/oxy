package so.oxy.assets

import java.io.InputStream
import java.io.InterruptedIOException
import java.security.MessageDigest

/** Reads on the native worker, without crossing the JS bridge or buffering the file. */
internal fun streamSha256(input: InputStream, cancelled: () -> Boolean, progress: (Long) -> Unit): Pair<String, Long> {
  val digest = MessageDigest.getInstance("SHA-256")
  val buffer = ByteArray(1024 * 1024)
  var loaded = 0L
  while (true) {
    if (cancelled()) throw InterruptedIOException("Upload hash cancelled")
    val count = input.read(buffer)
    if (count < 0) break
    if (count == 0) continue
    digest.update(buffer, 0, count)
    loaded += count
    progress(loaded)
  }
  if (cancelled()) throw InterruptedIOException("Upload hash cancelled")
  return digest.digest().joinToString("") { "%02x".format(it) } to loaded
}
