package expo.modules.kotlin.modules
import android.content.Context
object TestContext { lateinit var value: Context }
class AppContext { val reactContext: Context? get() = TestContext.value }
open class Module { val appContext = AppContext(); open fun definition(): ModuleDefinition = ModuleDefinition {} }
class ModuleDefinition(block: Builder.() -> Unit) { init { Builder().block() }; class Builder { fun Name(value: String) {}; fun <T> AsyncFunction(name: String, block: () -> T) {}; @Suppress("INVISIBLE_MEMBER", "INVISIBLE_REFERENCE") @kotlin.internal.LowPriorityInOverloadResolution fun <T> AsyncFunction(name: String, block: (String, String) -> T) {} } }
