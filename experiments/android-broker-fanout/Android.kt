package android.content
import android.net.Uri
import android.os.Bundle
class ProviderInfo
open class PackageManager { open fun resolveContentProvider(authority: String, flags: Int): ProviderInfo? = null }
open class ContentResolver { open fun call(uri: Uri, method: String, arg: String?, extras: Bundle?): Bundle? = null }
open class Context(val packageName: String, val packageManager: PackageManager, val contentResolver: ContentResolver)
