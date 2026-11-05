package so.oxy.devicesession

import org.junit.Assert.assertEquals
import org.junit.Test

class StoredDeviceSessionTest {
  @Test fun onlyBothMissingKeysAreAbsent() {
    assertEquals(DeviceSessionRead.Absent, classifyStoredDeviceSession(null, null))
  }

  @Test fun incompleteAndEmptyValuesAreUnavailable() {
    val unavailable = DeviceSessionRead.Unavailable("IncompleteStoredCredential")
    val incomplete = listOf(
      "device" to null,
      null to "holder",
      "" to "",
      null to "",
      "" to null,
      "device" to "",
      "" to "holder",
    )
    for ((id, secret) in incomplete) {
      assertEquals(unavailable, classifyStoredDeviceSession(id, secret))
    }
  }

  @Test fun completeRecordRemainsReadableAfterARepair() {
    val values = mutableMapOf(OxyDeviceSessionStore.KEY_DEVICE_ID to "device")
    val read: (String) -> String? = { values[it] }
    assertEquals(DeviceSessionRead.Unavailable("IncompleteStoredCredential"), readStoredDeviceSession(read))
    values[OxyDeviceSessionStore.KEY_DEVICE_SECRET] = "holder"
    assertEquals(DeviceSessionRead.Present("device", "holder"), readStoredDeviceSession(read))
    values.clear()
    assertEquals(DeviceSessionRead.Absent, readStoredDeviceSession(read))
  }

  @Test fun readErrorsRemainUnavailableWithoutLeakingMessages() {
    assertEquals(
      DeviceSessionRead.Unavailable("SecurityException"),
      readStoredDeviceSession { throw SecurityException("sensitive") },
    )
  }
}
