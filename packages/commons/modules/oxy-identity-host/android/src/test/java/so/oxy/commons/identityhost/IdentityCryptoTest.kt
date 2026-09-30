package so.oxy.commons.identityhost

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [IdentityCrypto] reproduces every value in `vectors.json`, the file
 * `@oxy.so/core`'s `identityDerivations` (noble) is checked against too, so the
 * Commons provider and the JS derivations cannot drift apart. The path comes
 * from build.gradle (`oxy.identityHost.vectors`).
 */
class IdentityCryptoTest {
  private val vectors: JSONObject by lazy {
    val path = System.getProperty("oxy.identityHost.vectors")
      ?: error("oxy.identityHost.vectors is not set; run through Gradle")
    JSONObject(File(path).readText())
  }

  private fun identities() = vectors.getJSONArray("identities").let { a -> (0 until a.length()).map { a.getJSONObject(it) } }

  @Test
  fun vectorsAreNotEmpty() {
    assertTrue(identities().size >= 3)
  }

  @Test
  fun publicKeysAndProofsMatch() {
    for (id in identities()) {
      val priv = id.getString("privateKey")
      val pub = id.getString("publicKey")
      assertEquals(pub, IdentityCrypto.publicKeyUncompressed(priv))
      assertTrue(IdentityCrypto.isHealthyPair(priv, pub))
      val proof = id.getJSONObject("proveIdentity")
      assertEquals(
        proof.getString("signature"),
        IdentityCrypto.proveIdentity(priv, pub, proof.getString("challenge"), proof.getLong("timestamp")),
      )
    }
  }

  @Test
  fun scopedSeedsMatch() {
    for (id in identities()) {
      val seeds = id.getJSONArray("scopedSeeds")
      for (i in 0 until seeds.length()) {
        val seed = seeds.getJSONObject(i)
        assertEquals(
          seed.getString("seed"),
          IdentityCrypto.deriveScopedSeed(id.getString("privateKey"), seed.getString("info")),
        )
      }
    }
  }

  @Test
  fun socialReceiveMatches() {
    for (id in identities()) {
      val entries = id.getJSONArray("socialReceive")
      for (i in 0 until entries.length()) {
        val e = entries.getJSONObject(i)
        val priv = id.getString("privateKey")
        val index = e.getLong("index").toInt()
        val (childPriv, childPub) = IdentityCrypto.socialReceiveChild(priv, index)
        assertEquals(e.getString("childPrivateKey"), childPriv)
        assertEquals(e.getString("childPublicKey"), childPub)
        val (signature, signedPub) = IdentityCrypto.signSocialReceive(priv, index, e.getString("digest"))
        assertEquals(e.getString("signature"), signature)
        assertEquals(childPub, signedPub)
      }
    }
  }

  @Test
  fun rejectsMalformedInput() {
    val id = identities().first()
    val priv = id.getString("privateKey")
    val pub = id.getString("publicKey")
    val good = "ab".repeat(32)
    assertThrows(IllegalArgumentException::class.java) { IdentityCrypto.proveIdentity(priv, pub, good.uppercase(), 1L) }
    assertThrows(IllegalArgumentException::class.java) { IdentityCrypto.proveIdentity(priv, pub, good.dropLast(2), 1L) }
    assertThrows(IllegalArgumentException::class.java) { IdentityCrypto.proveIdentity(priv, pub, "$good:1", 1L) }
    assertThrows(IllegalArgumentException::class.java) { IdentityCrypto.proveIdentity(priv, "04" + "00".repeat(64), good, 1L) }
    assertThrows(IllegalArgumentException::class.java) { IdentityCrypto.signSocialReceive(priv, 0, "zz".repeat(32)) }
    assertThrows(IllegalArgumentException::class.java) { IdentityCrypto.socialReceiveChild(priv, -1) }
    assertThrows(IllegalArgumentException::class.java) { IdentityCrypto.canonicalPrivateKey("00") }
    assertThrows(IllegalArgumentException::class.java) {
      IdentityCrypto.canonicalPrivateKey("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141")
    }
    assertFalse(IdentityCrypto.isHealthyPair(priv, "04" + "00".repeat(64)))
  }
}
