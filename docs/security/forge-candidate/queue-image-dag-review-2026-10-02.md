# Review of the unapplied queue image DAG

The [preparation diff](queue-image-dag-preparation.diff) is an artifact for review.
It is not applied to any workflow, permission, publication or deployment path.
The actual source decision remains INACTIVE. The previous policy question does
not authorize this changed candidate or the image pipeline below.

The proposed order is independent build/inspection -> authenticated small proof
artifact -> Guards -> CI complete -> registry publication of the same OCI
archive. An additional OCI archive artifact transports the already built bytes;
the publisher verifies its SHA256 before importing it with `--preserve-digests`,
then verifies the ECR manifest digest. It never rebuilds the image. Skopeo's
[documented preserve-digests behavior](https://github.com/podman-container-tools/skopeo/blob/main/docs/skopeo-copy.1.md)
fails when the digest cannot be preserved. The auth file is confined to a new
private temporary directory and removed after logout on EXIT, including failure.

Inspection has contents:read and no AWS permission. The authorize job reads
Actions metadata, waits for the exact merge_group CI and emits no OIDC token.
Only the subsequent publisher has id-token:write for the existing queue image
role; it also needs Actions read to fetch the existing artifacts. Guards needs
its separately reviewed Actions read permission for authenticated provenance
GETs. These are future permission changes, not granted by this branch.

Guards must accept a completed successful `inspection` job while that job's
workflow is still in progress. Waiting for the workflow's final conclusion would
create a cycle through publication. The synthetic binding fixture covers this
positive explicitly, with the publisher still pending. The proof cannot trust
an unfinished inspection job.

Source binding and image binding are separate. Authenticated metadata in
[queue-dag-review-2026-10-02](queue-dag-review-2026-10-02) confirms PR #1515 merged
at 2026-10-01 23:51 UTC with commit
`4b145040afca38be93ad4096241d4c60e12e1c82`. Its successful merge-group image run
36942256147 uses that same SHA; the current authenticated main ref and commit
also use it. The squash commit's parent is `c807c2b5`, rather than the PR head.
This proves the examined queue -> main transition preserved SHA, although
PR -> queue does not preserve ancestry. It does not promise all future rulesets
will preserve SHA. The future resolver requires the exact current main SHA;
a different SHA, even for an otherwise equal tree, fails until its own final
image proof and binding are reviewed. It cannot reuse an image solely by label
or fall back to an uninspected rebuild.

The isolated final-image contract checks both OCI archive and manifest hashes,
config bytes and ARM architecture, revision SHA and equality of the Docker
config ID with the mount/root/regression scan IDs. It rejects a different
archive, a rebuilt manifest, expired artifact, changed producer executable,
PR evidence for queue, or different final main SHA. Published phase also requires
the actual registry manifest and digest to equal the inspected one. Every fixture
is synthetic and returns authorized:false. No OCI image or registry operation
was run by these tests.

## Companions prepared; activation and real image evidence pending

The prepared collector uses fixed authenticated GitHub GETs for the exact queue
inspection run/job, a closed list of all workflow/build/scan/publish/collector
blobs, and the small proof ZIP digest. Its eleven required files include the
closed OCI receipt, manifest/config bytes, four scan IDs and producing workflow
execution. It runs the original whole-image Forge census, physical hash checks,
mount checks and 321 control-result validation. Caller facts remain synthetic
and cannot obtain the collector's private authentication marker.

The OCI ZIP is separately authenticated and streamed through a fixed Python
helper into an owned temporary directory, with a 4 GiB ZIP limit, 8 GiB archive
limit and 600 second deadline. The helper checks the actual ZIP/tar hashes,
bounded metadata, all blob filenames/hashes, config, manifest and referenced
layers without extracting files or keeping the archive in Node memory. Missing
bytes, null verification, duplicate files, path traversal, oversized metadata,
ambiguous jobs/artifacts, malformed pagination and elapsed polling fail closed.
The publisher compares the downloaded archive/config and inspected IDs again,
then checks the registry manifest digest after copying with preserved digests.

The strict resolver companion performs the normal live dependency audit, full
source-policy validation, exact main execution binding and published ECR manifest
comparison before returning a digest. ACTIVE cannot fall back to a rebuild;
INACTIVE retains the previous image selection/fallback behavior. The unapplied
diff connects this companion. An owned temporary Git fixture applies the diff
only to synthetic files, parses every YAML file and exercises actual shell
commands with synthetic gh/aws/bun receivers. No real workflow was applied.

Guards and deployment login receivers remove GH_TOKEN, GITHUB_TOKEN and
GH_CONFIG_DIR before storing the ephemeral token under the runner's OS home,
matching the collectors' scrubbed environment. Guards cleanup runs whenever
ACTIVE setup was attempted; deployment logout runs on EXIT, including a resolver
failure. Tests execute these exact diff commands with a fictitious token; they
never contact GitHub or write a real auth configuration. The future Guards time
cap is 45 minutes to cover bounded inspection waiting and streaming verification.
All these workflow and permission changes remain unapplied review artifacts.

Tracked-source validation on `298aab035ac14e5a39aef8bc7404ff5f8df29476`
is recorded in [proof.json](queue-companion-validation-2026-10-02/proof.json)
with exact source/output hashes and exits. Policy 118, real Git topology 20,
image binding 43, collector 48, unapplied DAG/resolver/auth 51, Python streaming
13, original proposal 131, original audit fixtures 9 and CI scope 38 pass.
The normal INACTIVE gate with the recorded Forge payload still exits 1, even
with all four tempting override variables. These fixture results neither
authenticate a new queue image nor activate an exception.

The small baseline ZIP used to derive content fixtures is the authenticated
historical PR artifact for `8f4485`, SHA256
`47811e6da747bab767d3be4fe175bf1a04affbac614317bd865ce39a61ee8b79`.
Tests project its content into explicitly synthetic queue/config/execution
fixtures. Those rewritten bytes are not queue evidence and never authorize a
real audit. No queue inspection, registry publication or deployment was run.

After the companions pass, freeze a new source target and collect its own ARM
proof. Existing `8f4485` evidence is historical and cannot authenticate the new
executables. Review the complete diff, permissions, final-image proof and seven
day decision independently. Nate must explicitly approve that concrete source
policy through this session or a separately established human mechanism before
any ACTIVE change. GitHub actor/committer identity from the shared agent token is
not proof of a human decision. Queue, merge, publication and deployment require
their own authorization; none follows from these offline fixtures.


## Expiry review correction (2026-10-02)

External [review 5960218626](https://github.com/OxyHQ/oxy/pull/1546#issuecomment-5960218626) identified stale timing after blocking image transport and CI waits. The candidate now refreshes OS time after all collector waits, authenticated GETs and OCI streaming; it checks the decision and both applicable artifacts again after local image/content verification. The original PR artifact and decision are rechecked at the final audit verdict. No original expiry is extended.

The unapplied publisher diff checks the exact committed policy/inventory and every applicable proof immediately before `skopeo copy`, after CI and credential/artifact setup. Transport downloads use a run-specific directory under `RUNNER_TEMP`; they cannot dirty the frozen source checkout. The clean-source rule is unchanged. Future credentials remain ephemeral and the diff is not materialized.

The exact collector source is executed in an isolated Node VM with command dependencies and OS clock replaced only inside that test realm. Policy starts valid, then expires during actual polling or Python-streaming boundaries; both return rejection. Proof/OCI artifact expiry and a later verdict are also covered. A control mutation removing the collector's final fresh-time assignment returns facts after expiry, demonstrating that this regression detects the stale collector. These synthetic metadata/commands are not authenticated GitHub evidence and cannot activate the runtime gate. The shell fixture separately proves rejection prevents even a mocked publication; real Git demonstrates that the old workspace transport layout dirties source and the `RUNNER_TEMP` layout remains clean.

This changes executed source and requires fresh exact-head image evidence. The previous ARM artifact is historical, not evidence for these changed executables or for the distinct #1537 integration input tree. Actual policy remains INACTIVE, workflows/permissions unchanged, and explicit human activation plus future queue/publisher evidence are still pending.
