# AND03 ciphertext fixture correction

Attempt 1 did not exercise encrypted preferences recovery. The former mutator changed the final nibble of the entire Tink EncryptedKeyset protobuf, which belonged to metadata after encrypted_keyset. The real device broker read returned present; the file remained unchanged. Root restored the exact original derived preferences file using CAS. Signer/pin ownership remained intact. No recovery success is claimed.

The replacement offline tool parses bounded protobuf wire framing and changes one hexadecimal nibble in the final byte of field 2 (`encrypted_keyset`), leaving field 3 (`keyset_info`) and every other byte unchanged. It refuses duplicate/missing/wrong-wire ciphertext, truncation, malformed/overlong varints, unsupported groups, oversized files, unsafe permissions and CAS mismatch. It invokes no ADB and does not change any device or key. Existing private backup/exclusive-output rules remain.

The original private file was inspected in memory only: protobuf length 242; field 2 spans [3,172); old mutation changed offset 241, new mutation changes offset 171. No ciphertext or plaintext is published. This proves the selected byte belongs to ciphertext, not that Android recovery has run. Root must review and operate attempt 2 on emulator-5580; all Metros remain unchanged.

RED: 11 tests, 1 behavioral failure (ciphertext unchanged) plus 15 subtest errors for the absent parser. GREEN: 11 tests passed. These are offline fixture tests, not Android acceptance. The historical attempt and rollback receipts remain private and are not overwritten.

Command: `python3 -m unittest discover -s scripts/rehearsal/android-keyset-corruption -v`.
