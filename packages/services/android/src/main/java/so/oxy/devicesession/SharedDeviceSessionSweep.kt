package so.oxy.devicesession

/** Resolve a host before calling it; a resolution error is not absence. */
internal fun readVisibleDeviceSession(
  resolve: () -> Boolean,
  read: () -> DeviceSessionRead,
): DeviceSessionRead {
  val installed = try {
    resolve()
  } catch (error: Exception) {
    return DeviceSessionRead.Unavailable(error.javaClass.simpleName)
  }
  return if (installed) read() else DeviceSessionRead.Absent
}

/**
 * Read every visible host before selecting a credential. A failed host cannot
 * establish which holder is safe to adopt or replace. If all hosts answer,
 * preserve the existing policy of selecting the first present credential.
 */
internal fun readSharedDeviceSessions(
  authorities: Iterable<String>,
  readHost: (String) -> DeviceSessionRead,
): DeviceSessionRead {
  var first: DeviceSessionRead.Present? = null
  var unavailable: DeviceSessionRead.Unavailable? = null
  for (authority in authorities) {
    when (val read = readHost(authority)) {
      is DeviceSessionRead.Present -> {
        if (first == null) first = read
      }
      is DeviceSessionRead.Unavailable -> unavailable = unavailable ?: read
      DeviceSessionRead.Absent -> Unit
    }
  }
  return unavailable ?: first ?: DeviceSessionRead.Absent
}
