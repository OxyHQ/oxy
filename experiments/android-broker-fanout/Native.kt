package so.oxy.devicesession
import android.content.Context
sealed interface DeviceSessionRead { data class Present(val deviceId: String, val deviceSecret: String): DeviceSessionRead; object Absent: DeviceSessionRead; data class Unavailable(val reason: String): DeviceSessionRead }
object OxyDeviceSessionStore { const val KEY_DEVICE_ID = "deviceId"; const val KEY_DEVICE_SECRET = "deviceSecret"; fun read(ctx: Context): DeviceSessionRead = DeviceSessionRead.Absent; fun write(ctx: Context, id: String, secret: String) = true; fun clear(ctx: Context) = true }
object OxyDeviceSessionProvider { const val KEY_STATUS = "status"; const val KEY_REASON = "reason"; const val KEY_OK = "ok"; const val STATUS_PRESENT = "present"; const val STATUS_ABSENT = "absent"; const val STATUS_UNAVAILABLE = "unavailable"; const val METHOD_READ = "read"; const val METHOD_WRITE = "write"; const val METHOD_CLEAR = "clear" }
