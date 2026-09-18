# Speech transport recovery — 2026-09-13

Status: candidate, not a production speech enablement.

The speech request previously discarded voice, format and speed, used text
modality, supplied maxOutputTokens=0 to a positive-only reservation field, and
had no binary stream event. The candidate preserves typed speech parameters,
reserves measured input characters, omits the inapplicable token limit, folds
bounded audio chunks and exposes `OxyInferenceClient.speech`.

Alia continues to use Oxy service authentication with delegated user identity.
Provider credentials and translation remain in Kaana. A new modality does not
permit Alia to call or sign Kaana directly. Audio parameters cannot authorize a
new route; Oxy's normal catalogue and signed authorization still apply.

## Verification

The initial candidate passed 661 contract tests, 1,828 core tests and all 6,754
API tests in three isolated shards, including real PostgreSQL migrations.
Signed edge tests verify independent base64 chunk reconstruction, MP3 bytes,
character settlement, invalid metadata and zero charge on malformed output.
Removing the audio-folding branch makes the positive regression test fail.

An unsharded API run crashed Node with SIGSEGV. The complete three-shard run
passed with no skipped tests. No test was deleted to avoid that crash.
The API build passed. API lint exits successfully with existing warnings.
Core's full warning-fatal lint reports 216 pre-existing errors outside the
changed files; warning-fatal lint on all three changed core source/test files
passes. This record does not claim the repository is globally lint-clean.

Current main added external identity contracts 1.1.0 while this work was in
progress. The proposal preserves those additions and reserves contracts 1.2.0
with core 1.0.2; the original contract-only 1.0.2 proposal is superseded.
Rebased contracts pass 665 tests; the complete rebased API passes 6,826 tests
across all three shards with no skips, and the complete API build passes.
Candidate versions have not been published.

## Publication and rollout blocker

The supplied npm credential returns 401 from the registry identity endpoint.
GitHub release job 103660761068 independently fails at the same authentication
step using the existing NPM_TOKEN secret. This is an actual publication blocker,
not a request for a second deployment approval.

Do not repin consumers to an unavailable registry artifact or claim speech is
live. After publication, update Kaana's exact contract pin and generated
snapshot, then perform the scoped serving/publisher rollout and review the
fresh exact deployment identity in Oxy's catalogue. Provision the speech-only
profile reserved by Alia (`cc2471c8-807e-46ec-b5da-b6f3b39d2db5`) through normal
reviewer authority, immutable price/score records and exact credential binding.
No speech catalogue provisioning is included in this candidate.

A direct real xAI Spanish TTS probe returned a decodable MP3 without using
OpenAI credit. That probe is not proof of the Alia -> Oxy -> Kaana product path.
The final authenticated product canary, settlement readback and canary cleanup
remain required before production speech can be called restored.
