# Inactive Forge audit policy candidate

This branch prepares a reviewable connection to the normal Security Audit gate.
The committed decision is `INACTIVE`, with no target, expiry, instruction or
independent-evidence claim. The live audit must still fail for
[GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv).
No exception, ACK, version rename, merge or deployment is authorized by this work.

The candidate starts from #1528 at
`b09309b62e0eb60ad9d2e43726d8fd11749180c7`. It preserves the original Forge patch,
the five installed-file hashes, and the original provenance collector and
proposal evaluator. That evaluator always returns `approved: false` and remains
a proposal. Its authenticated machine checks are technical inputs to the new
validator; they are not a security decision, and its `technicalEvidenceComplete`
flag is not rewritten.

## What a future source policy would check

The normal audit can suppress only the one exact high-severity Forge advisory.
It requires the complete canonical live audit to match the reviewed baseline;
new, removed or changed advisories fail. An invalid or expired ACTIVE policy
fails even if Forge disappears from the report, so it cannot become a stale
silent exception. Existing critical-advisory and unrelated acknowledgement
checks are retained.

The validator requires all of the following:

- The fixed committed decision JSON has exactly six fields. Nested instruction
  and evidence objects also have closed schemas. The instruction record is
  explicitly a session decision, with a digest and timestamp; expiry is required
  and bounded to seven days.
- `targetSourceHead` equals the source in the provenance pins. The current clean
  checkout descends from that target. Only the two exact paths
  `docs/security/forge-candidate/provenance/pins.json` and
  `docs/security/forge-candidate/provenance/audit-policy-decision.json` may differ.
- The normal audit script, this validator, its fixtures, CI workflow and every
  original image-proof executable blob equal the frozen target. An arbitrary
  file under `provenance/`, including another JSON file, does not qualify.
- The original live collector authenticates read-only GitHub GETs, the exact
  successful ARM job, the artifact digest, image identity, whole-image root
  census, unmounted proof targets and candidate regression bytes. Missing or
  expired artifacts fail.
- A real installed inventory exists and every physical Forge copy is version
  1.4.0 with the five exact candidate hashes. Missing inventory, a hidden stock
  copy or a renamed version fails.
- The independent proof and all 17 raw records are read from immutable target
  git objects and matched by digest. Required successful records cover stock
  and candidate upstream suites (828 passing, 4 pending each), the 14 own Expo
  public-API checks, the 34 Oxy tests, 321 known-key controls for each variant,
  and repeated-build snapshots. Initial failed Expo assertions remain visible.
- The entire `packages` source tree and root build/lock inputs equal the
  independently tested `b09309b62` source. These 34 Oxy tests cannot be carried
  over to a changed application compound. That would require new reproduction
  and a newly reviewed frozen candidate.

The candidate image workflow now accepts this one exact branch as well as the
original two candidate branches. It uses the final Dockerfile on ARM with
`--load`, read-only networkless proof containers and artifact upload. It has no
registry push, AWS access or deployment.

Guards reads the committed policy status. Only a future ACTIVE source row would
install the frozen byte inventory with dependency scripts disabled and create
an ephemeral `gh` login using the Actions token. Guards retains its existing
`contents: read` permission today. The additional `actions: read` permission
needed for private artifact GETs is an unapplied
[preparation diff](forge-candidate/audit-policy-actions-permission.diff); it is
not granted by this candidate. The token permits provenance GETs; it does not prove a human
approval. The login is removed afterwards. INACTIVE skips both setup steps.
Unavailable installation, ancestry or authentication keeps validation red.
Injected audit fixture payloads and environment ACK/approval flags cannot activate
the live gate.

## Human decision boundary and usable activation sequence

All agents in this session operate GitHub using the same NateIsern account.
An actor, author, committer, review or comment from that account is therefore
**not** proof that Nate personally made a decision. A JSON instruction record
also cannot cryptographically authenticate a person. Structural fixtures always
return `authorized: false`; their positive records are explicitly synthetic.
There is no automatic approval path through the shared token.

The process requires a separate explicit instruction from Nate in this session
(or a separately established human authorization mechanism) after reviewing a
concrete target and evidence. Until then the source row stays INACTIVE. Recording
such an instruction in reviewed source policy is a process trust boundary; this
candidate does not claim to solve independent human identity verification.

A realizable later sequence is:

1. Separately review and explicitly authorize the unapplied read-only Actions
   permission preparation. If it is accepted, apply it before freezing the
   target; that changes the workflow and therefore requires fresh source/ARM
   evidence. Without this step, inaccessible provenance keeps the gate red.
   Freeze the complete inactive source at an immutable target commit and run the
   candidate ARM workflow for that commit. Review the job, artifact and exact
   source/file digests. Existing #1528 pins describe an older source and cannot
   authorize this changed validator/workflow.
2. Prepare, but do not apply, a separate declarative diff containing updated pins
   and an ACTIVE decision for that exact target, independent-proof digest and
   concrete UTC expiry. No executable, evidence log or application source may
   change in that diff.
3. Ask Nate: **Do you authorize the temporary Security Audit exception for only
   GHSA-86w9-cpqp-85rv, using target `<full source SHA>`, ARM run/artifact
   `<IDs and digest>`, independent proof `<SHA-256>`, and expiry `<UTC>`, accepting
   the limits below?** Only an explicit answer authorizing that concrete decision
   permits applying the reviewed declarative diff.
4. Run the ordinary audit on the resulting clean checkout with installed bytes.
   Any failed precondition retains a red gate. A later code change needs a new
   frozen target and decision; the policy cannot reference its own commit SHA.

The source target and later declarative decision commit are deliberately
separate. This avoids requiring a file to contain the hash of its own commit.
Nothing in this candidate activates that sequence today. The pending permission
preparation is an explicit prerequisite, not an additional path permitted in a
later declarative activation diff.

## Evidence limits

The independent results are scoped technical evidence. The controls use known
private keys; they do not demonstrate a forgery without a private key. Four
upstream cases remain pending. The Expo checks exercise package public APIs,
not the upstream Expo suite, a device or a real OTA deployment. The original
proposal's remaining independent-review and policy-authorization requirements
are not erased. Authenticated provenance does not certify the patch's security
correctness or imply acceptance of those limits.

See [independent reproduction](1519-forge-independent-suites-2026-10-02.md) and
[raw proof](forge-independent/2026-10-02-b09309b/proof.json). Tests of this candidate
cover structural eligibility and rejection paths; they never assert that a human
has approved a live exception.

## Local validation of tracked candidate source

On `c79d348bc`, all executed source and fixtures were committed before testing.
The [validation proof](forge-candidate/audit-policy-validation-2026-10-02/proof.json)
records source hashes, raw output digests and exact exit statuses:

| Command | Result |
| --- | --- |
| `bun scripts/test-forge-audit-policy.mjs` | 94 structural/inactive assertions pass; synthetic positives never authorize |
| `bun scripts/test-check-dependency-audit.mjs` | 9 original audit cases pass |
| `node scripts/test-forge-remediation-proof-proposal.mjs` | 131 original inert assertions pass |
| `bun scripts/test-ci-scope.mjs` | 38 cases pass |
| `bun scripts/check-dependency-audit.mjs` | Expected exit 1, only the unacknowledged Forge GHSA reported |

The validator additionally invokes the normal gate with the recorded Forge
payload and all four tempting environment flags. It still exits 1 for the GHSA.
The current branch has no installed dependency inventory; INACTIVE neither
installs one nor infers a waiver from its absence. A fresh ARM run for this
candidate source is still required before any activation proposal.
