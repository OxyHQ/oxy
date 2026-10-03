# Independent Forge candidate review for #1519

Review date: 2026-10-02. This review does not approve an audit exception,
merge, deployment or publication. The integration branch contains neither
candidate patch. All security policy remains unchanged.

## Conclusion

[#1528](https://github.com/OxyHQ/oxy/pull/1528) is the stronger technical
candidate at `b09309b62e0eb60ad9d2e43726d8fd11749180c7`: its mitigation is
byte-identical to [#1517](https://github.com/OxyHQ/oxy/pull/1517) at
`da4121cea3040f42d471456a703a1c32da0dba37`, and it additionally binds evidence
to authenticated GitHub runs, inventories the full visible image filesystem,
and proves the three proof mount targets absent before mounting test scripts.
Those are material improvements in evidence integrity, not a stronger RSA
patch. Only one candidate should ultimately enter, after a separate decision.

The live [GitHub advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv)
was inspected on this date: affected versions are `<=1.4.0`, with no patched
version listed. Neither candidate makes the current version-based audit pass.
Authenticated image evidence is not authenticated human review or security
policy approval.

## Inspected evidence

| Check | #1517 | #1528 |
| --- | --- | --- |
| Exact head | `da4121cea3040f42d471456a703a1c32da0dba37` | `b09309b62e0eb60ad9d2e43726d8fd11749180c7` |
| Patch SHA256 | `6c8b35a750038ddae3b2973dd81cad4826fa31744053c878cd8959338edcd776` | identical |
| Five distributions, stock parity and candidate parity records | git blobs compared | byte-identical to #1517 |
| Independent local inert evaluator tests | 46 assertions pass | 131 assertions pass |
| Exact-head normal CI | [36951284023](https://github.com/OxyHQ/oxy/actions/runs/36951284023) | [36961389829](https://github.com/OxyHQ/oxy/actions/runs/36961389829) |
| Failing actual steps, read through GitHub Jobs API | `Security Audit: check`; consequential `Require every CI job to have passed` | same |
| ARM image proof | [36951283961](https://github.com/OxyHQ/oxy/actions/runs/36951283961), `/app` inventory | [36961389759](https://github.com/OxyHQ/oxy/actions/runs/36961389759), full visible root scan and unmounted targets |

The local assertion runs exported each candidate's exact tracked sources into
the reviewer's worktree and executed
`node --test scripts/test-forge-remediation-proof-proposal.mjs`. They verify
structural/adversarial behavior. They do not authenticate mocked facts.

The reviewer downloaded #1528 exact-head artifact `11208340340` with the
authenticated GitHub API and independently calculated ZIP SHA256
`af8fb29046e483155e5cee65ba65a15538d81c281fef308facd9086c8985d441`, matching
GitHub's artifact digest. The run API reports the exact head above, successful
`pull_request` execution, and the expected candidate image workflow. Inspected
artifact records contain nine installed roots; one physical Forge copy; all
five expected distribution hashes; ARM64; and 321 own-key control rows across
source and both browser bundles. The unmounted record identifies the same
source and shows `/proof/scripts`, `/proof/hashes`, `/proof/patches` absent.

#1528's checked-in pins intentionally name source
`d2f3d4bd1b87eaebec407f0124b5294e0f506f93` and run
[36960862475](https://github.com/OxyHQ/oxy/actions/runs/36960862475), not the
later pins-only head. The collector checks the permitted provenance-only
successor diff; the separate exact-head run above provides stronger direct
review evidence without changing those pins. A collector returning
`authenticatedProvenance:true` still always returns `approved:false`.

## Limits and remaining evidence

The 321 controls deliberately use a known private key to construct malformed
DigestInfo encodings. They establish rejection behavior and compatibility;
they are not a demonstrated no-private-key low-exponent forgery. The patch
checks nested DigestAlgorithm child count and empty ASN.1 NULL parameters after
ASN.1 validation, preserving the existing outer arity guard. This addresses the
specific parser weakness described by the advisory, but is not an upstream
security release or a proof of every RSA verifier property.

Both candidates report the same upstream Forge suite (828 passing, four
pending), Expo public API compatibility (14 checks), and Oxy signing/manifest
tests (34). Their documented reproduction removes upstream `describe.only`
only in the temporary Forge test checkout. The suite's upstream source,
toolchain lock and five generated outputs are pinned. The initial integration
review inspected those records without rerunning the suites. A separate
subagent then independently reproduced the exact #1528 source, stock/candidate
builds, both 828-pass/four-pending suites, an owned Expo14 public API harness,
Oxy34 consumer tests, and stock/candidate321 known-key controls. Its durable
[reproduction and logs](1519-forge-independent-suites-2026-10-02.md) distinguish
initial harness assertion failures from the corrected final results. This is
new independent execution evidence; it does not constitute policy approval.
The #1528 evaluator explicitly leaves caller-run Forge/Expo suites and review
authenticity unverified; `technicalEvidenceComplete:false` is correct.

## Concrete decisions available to Nate

1. Keep the existing audit policy and leave the queue blocked until a verified
   upstream patched version is available. A patch alone cannot satisfy this
   version-based gate.
2. Review the independent pinned stock/candidate builds, full Forge suite and
   Expo signing reproduction, and obtain authenticated security review of the
   exact #1528 patch and image receipts. Keep the gate unchanged during that
   review. A no-key exploit regression may be requested as additional evidence,
   with its absence stated accurately.
3. After that review, explicitly decide whether a narrowly scoped,
   time-bounded mitigation policy is acceptable for this one advisory, pinned
   to exact patch/distribution/image bytes, truthful version, expiry, owner and
   upstream replacement criteria. That would be a separate reviewable policy
   change with negative tests against missing, altered or unauthenticated
   evidence. This document neither implements nor approves it.

Renaming the package version, suppressing the audit, setting an approval flag
from caller input, or treating a candidate image as permission to deploy would
not provide the missing security decision. No such action was taken.
