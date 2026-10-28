package so.oxy.assets

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.io.InterruptedIOException
import java.security.MessageDigest
import org.junit.Assert.*
import org.junit.Test

class StreamSha256Test {
  @Test fun knownDigestAndProgress() {
    val progress = mutableListOf<Long>()
    val (digest, size) = streamSha256(ByteArrayInputStream("abc".toByteArray()), { false }, { progress.add(it) })
    assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", digest)
    assertEquals(3L, size)
    assertEquals(listOf(3L), progress)
  }
  @Test fun largerThanHeapStreamUsesBoundedReads() {
    val size = 370L * 1024 * 1024
    var remaining = size
    val expected = MessageDigest.getInstance("SHA-256")
    val input = object : InputStream() {
      override fun read(): Int = error("Must use bounded blocks")
      override fun read(bytes: ByteArray, offset: Int, count: Int): Int {
        assertTrue(count <= 1024 * 1024)
        if (remaining == 0L) return -1
        val length = minOf(count.toLong(), remaining).toInt()
        bytes.fill(7, offset, offset + length)
        expected.update(bytes, offset, length)
        remaining -= length
        return length
      }
    }
    val result = streamSha256(input, { false }, {})
    assertEquals(size, result.second)
    assertEquals(expected.digest().joinToString("") { "%02x".format(it) }, result.first)
  }
  @Test fun cancellationStopsBeforeReadingAnotherBlock() {
    var cancelled = false
    try {
      streamSha256(ByteArrayInputStream(ByteArray(2 * 1024 * 1024)), { cancelled }, { cancelled = true })
      fail("Expected cancellation")
    } catch (_: InterruptedIOException) { }
  }
}
