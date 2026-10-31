package so.oxy.devicesession

import org.junit.Assert.assertEquals
import org.junit.Test

class SharedDeviceSessionSweepTest {
  private val a = DeviceSessionRead.Present("device-a", "holder-a")
  private val b = DeviceSessionRead.Present("device-b", "holder-b")

  private fun sweep(vararg reads: DeviceSessionRead): DeviceSessionRead =
    readSharedDeviceSessions(reads.indices.map(Int::toString)) { reads[it.toInt()] }

  @Test fun absentHostIsNotCalled() {
    assertEquals(DeviceSessionRead.Absent, readVisibleDeviceSession({ false }) { error("not installed") })
  }

  @Test fun resolutionFailureDoesNotLookAbsentOrLeakItsMessage() {
    assertEquals(
      DeviceSessionRead.Unavailable("SecurityException"),
      readVisibleDeviceSession({ throw SecurityException("sensitive") }) { error("not called") },
    )
  }

  @Test fun nullProviderResponseIsUnavailable() {
    assertEquals(DeviceSessionRead.Unavailable("NullProviderResponse"), readProviderSafely { null })
  }

  @Test fun providerExceptionIsUnavailableWithoutItsMessageAndLaterReadCanRecover() {
    assertEquals(
      DeviceSessionRead.Unavailable("SecurityException"),
      readProviderSafely { throw SecurityException("sensitive") },
    )
    assertEquals(a, readProviderSafely { a })
  }

  @Test fun emptyHostsAreAbsent() {
    assertEquals(DeviceSessionRead.Absent, sweep(DeviceSessionRead.Absent, DeviceSessionRead.Absent))
  }

  @Test fun matchingHostsCanBeAdopted() {
    assertEquals(a, sweep(DeviceSessionRead.Absent, a, a))
  }

  @Test fun anyUnavailableHostBlocksAdoptionInEitherOrder() {
    val unavailable = DeviceSessionRead.Unavailable("SecurityException")
    assertEquals(unavailable, sweep(unavailable, a))
    assertEquals(unavailable, sweep(a, unavailable))
    assertEquals(unavailable, sweep(DeviceSessionRead.Absent, unavailable))
  }

  @Test fun preservesFirstPresentForDifferentDevicesAndSecrets() {
    assertEquals(a, sweep(a, b))
    assertEquals(a, sweep(a, DeviceSessionRead.Present("device-a", "new-holder")))
  }

  @Test fun laterHostIsActuallyReadAfterPresent() {
    val visited = mutableListOf<String>()
    val result = readSharedDeviceSessions(listOf("first", "second")) {
      visited.add(it)
      if (it == "first") a else DeviceSessionRead.Unavailable("NullProviderResponse")
    }
    assertEquals(listOf("first", "second"), visited)
    assertEquals(DeviceSessionRead.Unavailable("NullProviderResponse"), result)
  }

  @Test fun aLaterSuccessfulReadRecoversWithoutChangingHostOrder() {
    var failure = true
    val read: (String) -> DeviceSessionRead = {
      if (it == "first") a
      else if (failure) DeviceSessionRead.Unavailable("SecurityException") else b
    }
    val hosts = listOf("first", "second")
    assertEquals(DeviceSessionRead.Unavailable("SecurityException"), readSharedDeviceSessions(hosts, read))
    failure = false
    assertEquals(a, readSharedDeviceSessions(hosts, read))
  }

}
