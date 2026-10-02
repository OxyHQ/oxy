# Unapproved Forge 1.4.0 candidate

This is preparation for independent security review. It does not establish advisory remediation, change the audit gate, or authorize deployment. The package version remains 1.4.0.

The candidate adds nested DigestAlgorithm arity and empty-NULL checks after successful ASN.1 validation and the existing outer two-child check. It covers lib/rsa.js and both shipped RSA-containing browser bundles. Both maps were regenerated with the official configuration and remain byte-identical to their original single-mapping maps. The prime worker does not include RSA and is unchanged.

Reproduction: clone digitalbazaar/forge tag v1.4.0 at fa385f92440879601240020f158bed68e444e83a, copy toolchain.bun.lock to bun.lock, and run Bun 1.4.2 install --frozen-lockfile --minimum-release-age=0 --ignore-scripts. Apply only the lib/rsa.js hunk of patches/node-forge@1.4.0.patch, then bun run build using the unchanged webpack.config.js (webpack 4.47.0, webpack-cli 3.3.12). Hashes in candidate-hashes.json pin the stock and candidate files. Rebuilding stock source matched both official bundles/maps exactly; rebuilding candidate twice matched all five files.

Upstream full unit/security suite: NODE_ENV=test node node_modules/mocha/bin/mocha -t 30000 -R dot tests/unit/index.js, 828 passing / 4 pending. Upstream tests/unit/jsbn.js contains describe.only; remove that marker only in the temporary test checkout or the advertised suite executes just five tests. No test-source modification is shipped in the package patch.

Frozen whole-workspace installation matched every materialized Forge copy to all five candidate hashes. The existing API production dependency fixture passed. Docker manifest transport and portable production fixture both copy declared patch files before frozen installation. Lock synchronization checks reject a changed declaration, absent patch, or escaped path. Independent adversarial tests, Expo signing compatibility, image-byte proof and security review remain separate required gates. Bun audit remains version-based and still reports the advisory.

## Candidate image evidence
The candidate-only PR workflow builds the existing final Dockerfile on the existing ARM runner, without AWS, registry publication or deployment. Its isolated container has no network, no injected secrets, read-only mounts and no added capabilities. The image proof verifies every materialized Forge distribution and runs all 321 own-key protocol controls. This is technical evidence, not security-policy authorization; the ordinary version-based audit remains unchanged and failing for this advisory.

## Provenance enforcement (inert)
`node scripts/forge-remediation-proof-proposal.mjs [CLAIM.json [TEST_EVIDENCE.json]]` gathers every fact itself: git objects of the pinned source, a fresh `bun audit --json` from a fixed-location Bun 1.4.2, authenticated read-only `gh api --method GET` calls (run, job, artifact, merge ref, executed blobs, live GHSA), and the artifact ZIP whose bytes must match GitHub's digest. It always exits 1 and `approved` is always false.

- Trusted in reviewed code: exact advisory, version 1.4.0, patch hash, five distribution hashes, the whole-audit hash, the single lock resolution, the eight Docker-pruned links and their receipt, and the workflow identity (repository, workflow id/path, ARM job, step list, executed files).
- `provenance/pins.json` names one run (source, run, job, artifact, merge ref, image). It is checked against GitHub and the artifact, never trusted alone. HEAD may differ from the pinned source only inside `provenance/`; any other change means the run does not prove the current source.
- The complete root set comes from `forge-image-roots.json`: a scan of the whole image filesystem, excluding only `/dev`, `/proc`, `/sys` and the exact read-only `/proof/scripts` bind mount. Every physical Forge copy must be the one `/app` inventory copy. A Forge-shaped directory whose manifest is renamed, missing a version or malformed fails the scan.
- Caller claim and evidence can only add errors. Review or approval fields are refused. Facts not returned by `collect()` in the same process are structural only (`authenticatedProvenance: false`).
- Never machine-verified: caller-run Forge/Expo suites, the authenticity of the security review, and audit-policy authorization.

Run 36951283961 (source da4121ce) predates the whole-image root scan, so it fails closed. A new run of the hardened workflow, plus a reviewed commit pinning it, must come before any decision.
