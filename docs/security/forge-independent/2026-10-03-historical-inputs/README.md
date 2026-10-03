# Historical suite inputs after squash

CI [37103763728](https://github.com/OxyHQ/oxy/actions/runs/37103763728) on `248a80540b5c26db19ec2aee0ba12574b11a9cee` failed its Security Audit when the clean checkout could not resolve `9efa8d28e64f51ed32fc17dd1856e3a88d688268:packages`. Functional jobs passed; the aggregate failed. Policy was deactivated before this source change.

Source `f0a52948b543686c2e557ad0a015049c03c967e8` reads the exact historical commit and trees through authenticated, fixed-repository Git Data GETs. The immutable target proof supplies the historical SHA. All ten historical object IDs must equal the target’s local Git object IDs. Exact URLs, SHAs, non-truncated unique entries, tree/blob modes and traversal bounds are checked; no ref fetch, caller override or evidence exemption was added.

`node scripts/test-forge-independent-inputs.mjs` reproduces both old Git commands exiting 128 in a real clean clone after squash, then checks ten recovered objects against original and clone, plus malformed/foreign/unavailable inputs: 43 assertions. Synthetic GET callbacks convey no authentication. `node scripts/test-forge-audit-policy.mjs` invokes that test and rejects mismatched historical objects for each of the ten inputs: 144 assertions. The suite remains wired into CI; its new executable is included in the source equality gate.

`proof.json` records exact source/log hashes, commands, terminal markers and the authenticated real Git Data comparison. Proposal150, DAG82, legacy14 and audit10 also passed. Policy144 includes topology20, binding43, collector61, clock13 and OCI13. The old CI failure excerpt is retained and uncredited. No fresh Oxy34/Expo14/crypto/build runs are claimed: all ten input objects match the prior measured evidence.

Fresh ARM/provenance/full-gate review remains required before activation. Expiry stays 2026-10-09T22:00:00Z; no deployment or financial/authority mutation occurred.
