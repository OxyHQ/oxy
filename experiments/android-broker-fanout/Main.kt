package so.oxy.devicesession

import android.content.ContentResolver
import android.content.Context
import android.content.PackageManager
import android.content.ProviderInfo
import android.net.Uri
import android.os.Bundle
import expo.modules.kotlin.modules.TestContext
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

private data class Holder(val deviceId: String, val secret: String)

fun main() {
  val mode = System.getProperty("oxy.experiment.mode")
  check(mode == "current" || mode == "preserve")
  val first = "so.oxy.commons.devicesession"
  val second = "so.oxy.accounts.devicesession"
  val holders = ConcurrentHashMap<String, Holder>()
  var rejectSecond = false
  var concurrentWrite: (() -> Unit)? = null
  var afterFirstWrite: (() -> Unit)? = null
  val pm = object : PackageManager() {
    override fun resolveContentProvider(authority: String, flags: Int): ProviderInfo? =
      if (authority == first || authority == second) ProviderInfo() else null
  }
  val resolver = object : ContentResolver() {
    override fun call(uri: Uri, method: String, arg: String?, extras: Bundle?): Bundle? {
      val authority = uri.value.removePrefix("content://")
      return when (method) {
        "read" -> {
          val holder = holders[authority]
          Bundle().apply {
            if (holder == null) putString("status", "absent") else {
              putString("status", "present")
              putString("deviceId", holder.deviceId)
              putString("deviceSecret", holder.secret)
            }
          }
        }
        "write" -> {
          if (authority == second && rejectSecond) {
            concurrentWrite?.invoke()
            Bundle().apply { putBoolean("ok", false) }
          } else {
            val id = requireNotNull(extras?.getString("deviceId"))
            val secret = requireNotNull(extras?.getString("deviceSecret"))
            holders[authority] = Holder(id, secret)
            if (authority == first) afterFirstWrite?.invoke()
            Bundle().apply { putBoolean("ok", true) }
          }
        }
        "clear" -> {
          holders.remove(authority)
          Bundle().apply { putBoolean("ok", true) }
        }
        else -> error("unexpected method")
      }
    }
  }
  TestContext.value = Context("earth.mention.app", pm, resolver)
  val module = OxyDeviceSessionModule()
  val read = module.javaClass.getDeclaredMethod("readShared").apply { isAccessible = true }
  val publish = module.javaClass.getDeclaredMethod("publish", String::class.java, String::class.java)
    .apply { isAccessible = true }
  fun write(id: String, secret: String) = publish.invoke(module, id, secret) as Boolean
  fun readSlot() = read.invoke(module) as Map<*, *>

  /* A concurrent writer replaces the second host before failed-write cleanup. */
  holders[first] = Holder("device", "old")
  holders[second] = Holder("device", "old")
  rejectSecond = true
  val blocked = CountDownLatch(1)
  val replaced = CountDownLatch(1)
  val writer = Thread {
    check(blocked.await(5, TimeUnit.SECONDS))
    holders[first] = Holder("device", "concurrent")
    holders[second] = Holder("device", "concurrent")
    replaced.countDown()
  }
  concurrentWrite = {
    blocked.countDown()
    check(replaced.await(5, TimeUnit.SECONDS))
  }
  writer.start()
  val cleanupResult = write("device", "candidate")
  writer.join()
  if (mode == "current") {
    check(cleanupResult && holders[second] == null)
    println("current: failed-write clear erased a concurrently replaced holder and returned success")
  } else {
    check(!cleanupResult && holders[second] == Holder("device", "concurrent"))
    println("preserve experiment: concurrent holder survives and publish returns false")
  }

  /* The first host accepted a write, the second host kept an older holder. */
  holders[first] = Holder("device", "old")
  holders[second] = Holder("device", "old")
  concurrentWrite = null
  val partialResult = write("device", "candidate")
  if (mode == "preserve") {
    check(!partialResult && holders[second] == Holder("device", "old"))
    val selected = readSlot()
    check(selected["status"] == "present" && selected["deviceSecret"] == "candidate")
    println("preserve experiment: partial write leaves second host old while read selects the new first host")
  }

  /* Simulate an opt-in detailed read, holder proof, and an immediate re-read. */
  rejectSecond = false
  holders[first] = Holder("device", "old-one")
  holders[second] = Holder("device", "old-two")
  val candidate = Holder("device", "candidate")
  fun sameDeviceSnapshot(): Boolean = listOf(holders[first], holders[second]).all { it?.deviceId == candidate.deviceId }
  check(sameDeviceSnapshot())
  val simulatedHolderProof = true
  check(simulatedHolderProof && sameDeviceSnapshot())
  val legacyMayWrite = CountDownLatch(1)
  val legacyDone = CountDownLatch(1)
  val legacy = Thread {
    check(legacyMayWrite.await(5, TimeUnit.SECONDS))
    holders[first] = Holder("other-device", "other-holder")
    holders[second] = Holder("other-device", "other-holder")
    legacyDone.countDown()
  }
  afterFirstWrite = {
    legacyMayWrite.countDown()
    check(legacyDone.await(5, TimeUnit.SECONDS))
  }
  legacy.start()
  check(write(candidate.deviceId, candidate.secret))
  legacy.join()
  check(holders[first] == Holder("other-device", "other-holder"))
  check(holders[second] == candidate)
  afterFirstWrite = null
  println("both: a same-device preflight and recheck did not protect a later legacy replacement during fan-out")

  /* A legacy caller can act on an empty read after a newer caller publishes. */
  rejectSecond = false
  holders.clear()
  check(readSlot()["status"] == "absent")
  check(write("device-new", "new"))
  check(write("device-legacy", "legacy"))
  check(holders[first] == Holder("device-legacy", "legacy"))
  check(holders[second] == Holder("device-legacy", "legacy"))
  println("both: a delayed legacy publish overwrote a newer publication")
}
