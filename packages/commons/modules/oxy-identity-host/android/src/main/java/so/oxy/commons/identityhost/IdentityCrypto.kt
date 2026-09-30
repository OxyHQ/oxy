package so.oxy.commons.identityhost

import java.math.BigInteger
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.ec.CustomNamedCurves
import org.bouncycastle.crypto.params.ECDomainParameters
import org.bouncycastle.crypto.params.ECPrivateKeyParameters
import org.bouncycastle.crypto.signers.ECDSASigner
import org.bouncycastle.crypto.signers.HMacDSAKCalculator

/**
 * What Commons computes FROM the identity private key, so that nothing else
 * ever needs the key itself.
 *
 * Pure JVM (no `android.*`), so the unit test runs it against the vectors in
 * `../vectors.json`, the same file `@oxy.so/core`'s `identityDerivations` is
 * checked against. The two implementations must agree byte for byte:
 *
 * - [proveIdentity]: the server challenge proof. RFC 6979 ECDSA over
 *   `sha256("auth:${publicKey}:${challenge}:${timestamp}")`, DER, WITHOUT low-S
 *   normalization (noble `lowS: false`, which `POST /auth/verify` accepts).
 * - [deriveScopedSeed]: `HKDF-SHA256(key, "oxy-identity-scoped-seed-v1", info, 32)`,
 *   `KeyManager.deriveScopedSeed` on the device that holds the key.
 * - [socialReceiveChild] / [signSocialReceive]: the non-hardened BIP32 child of
 *   `@fairco.in/core`'s social-receive scheme, signed low-S (BIP 62).
 */
object IdentityCrypto {
  private const val SCOPED_SEED_SALT = "oxy-identity-scoped-seed-v1"
  private const val SOCIAL_RECEIVE_CHAIN_CODE_KEY = "oxypay/faircoin/social/v1"
  const val MAX_SOCIAL_RECEIVE_INDEX = 0x7fffffff

  private val CHALLENGE = Regex("^[0-9a-f]{64}$")
  private val DIGEST = Regex("^[0-9a-f]{64}$")
  private val HEX = Regex("^[0-9a-fA-F]{1,64}$")

  private val curve = CustomNamedCurves.getByName("secp256k1")
  private val domain = ECDomainParameters(curve.curve, curve.g, curve.n, curve.h)
  private val n: BigInteger = curve.n
  private val halfN: BigInteger = n.shiftRight(1)

  fun authMessage(publicKey: String, challenge: String, timestamp: Long): String =
    "auth:$publicKey:$challenge:$timestamp"

  /** Lowercase, left-padded to 64, and a valid scalar in [1, n-1]. */
  fun canonicalPrivateKey(privateKeyHex: String): String {
    require(HEX.matches(privateKeyHex)) { "private key must be 1 to 64 hex characters" }
    val canonical = privateKeyHex.lowercase().padStart(64, '0')
    val d = BigInteger(canonical, 16)
    require(d.signum() > 0 && d < n) { "private key is outside the secp256k1 scalar range" }
    return canonical
  }

  /** Lowercase uncompressed SEC1 public key (65 bytes). */
  fun publicKeyUncompressed(privateKeyHex: String): String =
    toHex(curve.g.multiply(scalar(privateKeyHex)).normalize().getEncoded(false))

  private fun publicKeyCompressedBytes(d: BigInteger): ByteArray =
    curve.g.multiply(d).normalize().getEncoded(true)

  /** True when [publicKeyHex] is the key [privateKeyHex] derives (compared uncompressed). */
  fun isHealthyPair(privateKeyHex: String, publicKeyHex: String): Boolean =
    runCatching { publicKeyUncompressed(privateKeyHex) == publicKeyHex.lowercase() }.getOrDefault(false)

  /**
   * Sign a server challenge (64 lowercase hex, as `SignatureService.generateChallenge`
   * issues) for `POST /auth/verify`. Commons builds the whole message itself; the
   * caller supplies only the challenge.
   */
  fun proveIdentity(privateKeyHex: String, publicKeyHex: String, challenge: String, timestamp: Long): String {
    require(CHALLENGE.matches(challenge)) { "challenge must be 64 lowercase hex characters" }
    require(isHealthyPair(privateKeyHex, publicKeyHex)) { "public key does not match the private key" }
    val digest = MessageDigest.getInstance("SHA-256")
      .digest(authMessage(publicKeyHex, challenge, timestamp).toByteArray(Charsets.UTF_8))
    return sign(scalar(privateKeyHex), digest, lowS = false)
  }

  /** HKDF-SHA256 (RFC 5869) over the 32-byte key, 32 bytes of output, hex. */
  fun deriveScopedSeed(privateKeyHex: String, info: String): String {
    val ikm = fromHex(canonicalPrivateKey(privateKeyHex))
    val prk = hmac("HmacSHA256", SCOPED_SEED_SALT.toByteArray(Charsets.UTF_8), ikm)
    // L = 32 = HashLen: one block, T(1) = HMAC(PRK, info || 0x01).
    val okm = hmac("HmacSHA256", prk, info.toByteArray(Charsets.UTF_8) + byteArrayOf(0x01))
    return toHex(okm)
  }

  /** Social-receive child [index]: (child private key hex, child compressed public key hex). */
  fun socialReceiveChild(privateKeyHex: String, index: Int): Pair<String, String> {
    require(index in 0..MAX_SOCIAL_RECEIVE_INDEX) { "index must be in [0, $MAX_SOCIAL_RECEIVE_INDEX]" }
    val k = scalar(privateKeyHex)
    val parentPublic = publicKeyCompressedBytes(k)
    val chainCode = hmac("HmacSHA256", SOCIAL_RECEIVE_CHAIN_CODE_KEY.toByteArray(Charsets.UTF_8), parentPublic)
    val data = parentPublic + byteArrayOf(
      (index ushr 24).toByte(),
      (index ushr 16).toByte(),
      (index ushr 8).toByte(),
      index.toByte(),
    )
    val i = hmac("HmacSHA512", chainCode, data)
    val il = BigInteger(1, i.copyOfRange(0, 32))
    require(il < n) { "invalid social-receive child (IL >= n)" }
    val child = il.add(k).mod(n)
    require(child.signum() != 0) { "invalid social-receive child (zero key)" }
    return toHex32(child) to toHex(publicKeyCompressedBytes(child))
  }

  /** Sign a 32-byte digest with social-receive child [index]: (DER hex, low-S; child compressed public key). */
  fun signSocialReceive(privateKeyHex: String, index: Int, digestHex: String): Pair<String, String> {
    require(DIGEST.matches(digestHex)) { "digest must be 64 lowercase hex characters" }
    val (childPrivate, childPublic) = socialReceiveChild(privateKeyHex, index)
    return sign(BigInteger(childPrivate, 16), fromHex(digestHex), lowS = true) to childPublic
  }

  private fun scalar(privateKeyHex: String): BigInteger = BigInteger(canonicalPrivateKey(privateKeyHex), 16)

  private fun sign(d: BigInteger, digest: ByteArray, lowS: Boolean): String {
    val signer = ECDSASigner(HMacDSAKCalculator(SHA256Digest()))
    signer.init(true, ECPrivateKeyParameters(d, domain))
    val (r, rawS) = signer.generateSignature(digest).let { it[0] to it[1] }
    val s = if (lowS && rawS > halfN) n.subtract(rawS) else rawS
    return toHex(derSignature(r, s))
  }

  /** `30 len 02 len r 02 len s`, minimal positive integers (noble's `toHex('der')`). */
  private fun derSignature(r: BigInteger, s: BigInteger): ByteArray {
    val rb = derInteger(r)
    val sb = derInteger(s)
    return byteArrayOf(0x30, (rb.size + sb.size).toByte()) + rb + sb
  }

  private fun derInteger(value: BigInteger): ByteArray {
    // BigInteger.toByteArray() is minimal two's complement: a leading 0x00 only
    // when the high bit is set, which is exactly DER's positive INTEGER.
    val bytes = value.toByteArray()
    return byteArrayOf(0x02, bytes.size.toByte()) + bytes
  }

  private fun hmac(algorithm: String, key: ByteArray, data: ByteArray): ByteArray {
    val mac = Mac.getInstance(algorithm)
    mac.init(SecretKeySpec(key, algorithm))
    return mac.doFinal(data)
  }

  private fun toHex32(value: BigInteger): String = value.toString(16).padStart(64, '0')

  private fun toHex(bytes: ByteArray): String {
    val out = StringBuilder(bytes.size * 2)
    for (b in bytes) {
      out.append(Character.forDigit((b.toInt() shr 4) and 0xf, 16))
      out.append(Character.forDigit(b.toInt() and 0xf, 16))
    }
    return out.toString()
  }

  private fun fromHex(hex: String): ByteArray =
    ByteArray(hex.length / 2) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
}
