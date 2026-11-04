package so.oxy.devicesession

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedDeviceSessionPublishTest {
  private val hosts = listOf("first", "second")

  @Test
  fun resolutionFailureBeforeOrAfterPresentHostDoesNotWriteOrClear() {
    for (failed in hosts) {
      val writes = mutableListOf<String>()
      val clears = mutableListOf<String>()
      val result = publishSharedDeviceSessions(
        hosts,
        { host -> if (host == failed) throw SecurityException() else true },
        { host -> writes.add(host); true },
        { host -> clears.add(host); true },
      )
      assertFalse(result)
      assertTrue(writes.isEmpty())
      assertTrue(clears.isEmpty())
    }
  }

  @Test
  fun emptyHostSetAndFirstBootRemainCompatible() {
    val writes = mutableListOf<String>()
    val absent = publishSharedDeviceSessions(hosts, { false }, { writes.add(it); true }, { true })
    assertFalse(absent)
    assertTrue(writes.isEmpty())

    val published = publishSharedDeviceSessions(hosts, { it == "first" }, { writes.add(it); true }, { true })
    assertTrue(published)
    assertEquals(listOf("first"), writes)
  }

  @Test
  fun transientResolutionFailureRecoversOnNextAttempt() {
    var failing = true
    val writes = mutableListOf<String>()
    fun publish() = publishSharedDeviceSessions(
      hosts,
      { host -> if (host == "second" && failing) throw IllegalStateException() else true },
      { host -> writes.add(host); true },
      { true },
    )
    assertFalse(publish())
    assertTrue(writes.isEmpty())
    failing = false
    assertTrue(publish())
    assertEquals(hosts, writes)
  }

  @Test
  fun legacyWriteAndClearOutcomesRemainUnchanged() {
    val clears = mutableListOf<String>()
    val result = publishSharedDeviceSessions(
      hosts,
      { true },
      { it == "first" },
      { host -> clears.add(host); true },
    )
    assertTrue(result)
    assertEquals(listOf("second"), clears)
  }
}
