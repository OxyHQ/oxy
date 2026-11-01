package android.os
class Bundle { private val data = mutableMapOf<String, Any>(); fun putString(k: String, v: String) { data[k] = v }; fun putBoolean(k: String, v: Boolean) { data[k] = v }; fun getString(k: String) = data[k] as? String; fun getBoolean(k: String, d: Boolean) = data[k] as? Boolean ?: d }
