package so.oxy.devicesession

/** Resolve the entire visible host set before writing to any host. */
internal fun publishSharedDeviceSessions(
  authorities: Iterable<String>,
  isInstalled: (String) -> Boolean,
  writeHost: (String) -> Boolean,
  clearHost: (String) -> Boolean,
): Boolean {
  val installed = runCatching { authorities.filter(isInstalled) }.getOrElse { return false }
  var confirmed = 0
  var stale = false
  for (authority in installed) {
    if (writeHost(authority)) {
      confirmed += 1
    } else if (!clearHost(authority)) {
      stale = true
    }
  }
  return confirmed > 0 && !stale
}
