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

## Required companion work before applying this diff

The future live collector must authenticate the exact queue inspection run/job,
its frozen workflow and all executed scan blobs, small proof ZIP digest and
closed receipt, plus the actual Forge whole-image census and 321 control results.
It must bind the separately uploaded OCI transport to the trusted producer and
validate the manifest/config relation. No caller JSON or synthetic success flag
can stand in for these GETs or artifact bytes. The publisher validates downloaded
archive bytes again before use.

The current preparation diff deliberately leaves the ACTIVE deployment resolver
blocked until that receipt collector and its real script fixtures exist. Guards
also explicitly refuses queue/main image authorization, including a descendant
merge_group topology. The collector, polling limits, frozen executed-blob list,
strict resolver and its error cases are unfinished companion implementations.
The workflows must not be materialized while they are absent. This is a concrete
remaining blocker, not a claim that a permanently failing pipeline is ready.

After the companions pass, freeze a new source target and collect its own ARM
proof. Existing `8f4485` evidence is historical and cannot authenticate the new
executables. Review the complete diff, permissions, final-image proof and seven
day decision independently. Nate must explicitly approve that concrete source
policy through this session or a separately established human mechanism before
any ACTIVE change. GitHub actor/committer identity from the shared agent token is
not proof of a human decision. Queue, merge, publication and deployment require
their own authorization; none follows from these offline fixtures.
