# AND03 owned Android recovery observations

Root operated emulator-5580 and the synthetic Commons identity. This records real Android file recovery, not a mock and not an operation on the physical Pixel. Source/APK/bundle and private evidence hashes are pinned in proof.json; only whitelisted status and file hashes are copied here.

Attempt1 altered keyset metadata and did not trigger recovery. Its real broker call returned present, the derived file remained corrupt, and root restored the original file under CAS. That failure and rollback remain in the record.

Attempt2 changed one nibble in the encrypted_keyset ciphertext authentication tag. The real SDK broker read reached the Commons Android store: native logs report unreadable preferences then regeneration, and the derived file changed from f62dc127… (1500 bytes) to ae17ff04… (1136 bytes). The identity signer and SecureStore bytes were identical immediately before/after recovery; all four Keystore aliases remained and no backup files remained. No rollback overwrote the healed file.

After recovery, the actual SDK reported the same owner/profile, canonical pin owner/key match, unchanged public key and authenticated/private-ready state. Mention then read the same profile through the SDK. Mention already held durable credentials, so this does not demonstrate fresh-UID adoption after recovery. The broker's `present` status may use Accounts as fallback; file hashes and native recovery logs establish the Commons repair.

The earlier SecureStore bootstrap change is explicitly outside the byte-invariance interval. Candidate SDK/fixture acceptance does not replace the final published dependency repeat or resolve the separate native touch observation.
