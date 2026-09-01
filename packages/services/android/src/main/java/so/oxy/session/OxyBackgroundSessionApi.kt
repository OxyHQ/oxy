package so.oxy.session

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.text.ParseException
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

/**
 * The one network call background code makes: `POST /session/device/background-token`.
 *
 * Bearer-less and cookie-less — possession of the provisioned secret IS the
 * proof. Unlike `POST /session/device/token` this NEVER rotates: the presented
 * secret stays valid until it expires or is revoked, which is what makes it safe
 * to call from a process the OS may kill at any moment.
 *
 * `HttpURLConnection` rather than an HTTP client library, for the same reason
 * Mention's widget uses it: this is one small POST, and adding an HTTP stack to
 * every consuming app's release APK would cost more than it saves.
 */
internal object OxyBackgroundSessionApi {
  private val CONNECT_TIMEOUT_MS = TimeUnit.SECONDS.toMillis(10).toInt()
  private val READ_TIMEOUT_MS = TimeUnit.SECONDS.toMillis(15).toInt()

  /**
   * The two server verdicts that PROVE the credential is finished, and the only
   * two that may delete it.
   *
   * This mirrors `@oxyhq/core`'s `refresh.ts` rule deliberately, and for the same
   * hard-won reason: ANY other 401 — a proxy or middleware 401, an ALB answering
   * for a starting instance, an HTML error page during a deploy — is NOT proof
   * that a credential is bad. Treating an ambiguous 401 as revocation is what
   * logged users out ecosystem-wide once already. Here the blast radius is
   * smaller (a widget going blank rather than a session dying) but the rule is
   * the same, so the failure mode reads identically to anyone debugging it.
   *
   * These strings are wire contract with oxy-api, not log text.
   */
  private const val ERROR_CREDENTIAL_INVALID = "background_credential_invalid"
  private const val ERROR_ACCOUNT_NOT_ON_DEVICE = "account_not_on_device"

  internal sealed interface MintOutcome {
    data class Minted(val accessToken: String, val expiresAt: Long, val accountId: String) : MintOutcome
    /** An explicit server verdict: this credential is finished. Delete it. */
    data object Revoked : MintOutcome
    data class Transient(val cause: Exception) : MintOutcome
    data class Malformed(val cause: Exception) : MintOutcome
  }

  suspend fun mint(credential: OxyBackgroundSessionStore.Credential): MintOutcome =
    withContext(Dispatchers.IO) {
      val endpoint = "${credential.baseUrl.trimEnd('/')}/session/device/background-token"
      val body = JSONObject()
        .put("deviceId", credential.deviceId)
        .put("secret", credential.secret)
        .toString()

      val connection: HttpURLConnection = try {
        (URL(endpoint).openConnection() as HttpURLConnection).apply {
          requestMethod = "POST"
          connectTimeout = CONNECT_TIMEOUT_MS
          readTimeout = READ_TIMEOUT_MS
          doOutput = true
          // No Authorization header and no cookies, by design.
          setRequestProperty("Content-Type", "application/json")
          setRequestProperty("Accept", "application/json")
        }
      } catch (cause: IOException) {
        return@withContext MintOutcome.Transient(cause)
      }

      try {
        connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        val status = connection.responseCode
        if (status != HttpURLConnection.HTTP_OK) {
          return@withContext classifyFailure(status, readErrorBody(connection))
        }
        val payload = connection.inputStream.bufferedReader().use { it.readText() }
        parseMintResponse(payload)
      } catch (cause: IOException) {
        // Connect/read failure, DNS, TLS, a dropped socket mid-body.
        MintOutcome.Transient(cause)
      } finally {
        connection.disconnect()
      }
    }

  /**
   * Read the error body, tolerating its absence — `errorStream` is null for some
   * statuses, and a failure to read the explanation of a failure must not become
   * a different failure.
   */
  private fun readErrorBody(connection: HttpURLConnection): String =
    try {
      connection.errorStream?.bufferedReader()?.use { it.readText() } ?: ""
    } catch (cause: IOException) {
      ""
    }

  /**
   * A non-200 becomes [MintOutcome.Revoked] ONLY on an explicit verdict; every
   * other status and every unrecognised 401 is [MintOutcome.Transient] so the
   * credential is kept. Substring matching on the raw body (rather than parsing
   * it) is deliberate: it is what core does, and it survives the body being an
   * error page rather than the JSON envelope.
   */
  private fun classifyFailure(status: Int, body: String): MintOutcome {
    if (status == HttpURLConnection.HTTP_UNAUTHORIZED &&
      (body.contains(ERROR_CREDENTIAL_INVALID) || body.contains(ERROR_ACCOUNT_NOT_ON_DEVICE))
    ) {
      return MintOutcome.Revoked
    }
    return MintOutcome.Transient(IOException("POST /session/device/background-token responded $status"))
  }

  private fun parseMintResponse(payload: String): MintOutcome =
    try {
      val data = JSONObject(payload).getJSONObject("data")
      val accessToken = data.getString("accessToken")
      val accountId = data.getString("accountId")
      val expiresAt = parseIsoInstant(data.getString("expiresAt"))
      if (accessToken.isEmpty() || accountId.isEmpty()) {
        MintOutcome.Malformed(JSONException("background-token response had an empty accessToken or accountId"))
      } else {
        MintOutcome.Minted(accessToken, expiresAt, accountId)
      }
    } catch (cause: JSONException) {
      MintOutcome.Malformed(cause)
    } catch (cause: ParseException) {
      MintOutcome.Malformed(cause)
    }

  /**
   * Parse the server's `expiresAt` into epoch millis.
   *
   * The shape is fixed rather than guessed: oxy-api emits it with JavaScript's
   * `Date.toISOString()`, which is specified to produce exactly
   * `yyyy-MM-ddTHH:mm:ss.sssZ`. `SimpleDateFormat` (rather than `java.time`)
   * because `Instant.parse` needs API 26 or core-library desugaring, and this
   * module must compile for every consuming app's minSdk without imposing a
   * build-config requirement on them.
   *
   * Anything else throws [ParseException], which the caller classifies as
   * `Malformed` — never a silent fallback to a made-up expiry, which would either
   * throw away a valid token or keep using a dead one.
   */
  private fun parseIsoInstant(value: String): Long {
    val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US).apply {
      timeZone = TimeZone.getTimeZone("UTC")
      isLenient = false
    }
    val parsed = format.parse(value) ?: throw ParseException("unparseable expiresAt: $value", 0)
    return parsed.time
  }
}
