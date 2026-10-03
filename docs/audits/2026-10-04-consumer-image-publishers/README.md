# Reviewed consumer ARM image publishers

Prepared templates only. No consumer files were edited, no Actions workflow was dispatched and no AWS read or write was performed by this preparation. Root reviews the exact source and i04 applies the delivered files alongside the final registry dependency changes.

`docs/architecture/1519-consumer-image-publishers/manifest.json` lists the destination files, their SHA256, the reviewed source inputs and dispatch command per repository. Copy the three files under each repository directory to the same relative destination in that repository. GoWay, Homiio and TNP also receive their existing `ci.yml` with only the four caller conditions amended. Check its before hash against the manifest's sourceInputs before applying; if another edit intervened, apply just the reviewed condition delta and review the resulting combined file.

There are 16 repositories, 19 native ARM image builds and 20 affected services. Clarity API and worker reuse one image. Homiio's two targets use distinct full-source-SHA tags with `-api`/`-worker` suffixes in the same ECR repository. TNP DNS is excluded. Atlas has no ECS image. Existing automatic/reusable/merge-queue publishers remain unchanged. Alia has no declared GHA cache and these templates add none; the other cache scopes and all three AWS roles come from the reviewed existing publisher sources.

Each new workflow permits only manual execution on its own main branch, receives an expected full source SHA and compares it with `github.sha` and clean Git HEAD before assuming the existing publisher role. Dockerfile path, hash, target, ECR repository and cache scope are closed in the committed recipe. The runner is `ubuntu-24.04-arm`; there is no QEMU rebuild, ECS/SSM command, migration, seed, IAM modification, task-role change or latest tag. Existing AWS publisher roles retain their existing permissions; this workflow uses ECR only and does not narrow the IAM role itself.

The build publishes a single ARM64 manifest with provenance/SBOM index generation disabled. Source/tree/Dockerfile labels and the build output digest are verified against authenticated ECR manifest bytes and a bounded, hashed config download. Redirects are refused and presigned URLs stay in memory. The retained artifact contains the exact manifest bytes, build metadata and source/digest receipt under RUNNER_TEMP; it does not dirty the source checkout. Root still verifies Actions run/job/artifact provenance and ECR digest independently before making a promotion receipt. A build artifact is evidence of an image, not evidence of database migration or service acceptance.

The publisher refuses a pre-existing source tag. This guard is not an atomic ECR compare-and-swap and does not change repository tag-mutability settings: root must hold/serialize all other publishers first. A failed/lost Actions response may leave a published image even if there is no successful proof artifact. Reconcile the exact run, job, tag and ECR digest before any retry; never overwrite the tag or infer provenance from its source label alone. No automated retry or reuse is provided.

Before merging GoWay/Homiio/TNP, root sets repository variable `OXY_1519_ROLLOUT_HOLD=true`. The four existing CI caller jobs then skip their deploy/publication while all other jobs and gates retain their original conditions. Unset/false restores their original condition; capture and deliberately restore the original variable state after the controlled rollout. The new strict manual publisher intentionally remains available during this hold. Disabling a reusable workflow alone is not treated as proof that its CI caller is disabled.

After review/application and exact main CI, root captures the merged SHA and runs the command from manifest.json with that SHA substituted. There are no arbitrary role, Dockerfile, target, tag, build-argument or service inputs. These workflows contain no package registry publication. Consumer promotion, explicit migration receipts, per-service smoke, worker visibility and scaler restoration remain separate root operations governed by the accepted consumer-promotion plan.

Validation: 32 offline tests exercise real temporary Git source guards, two real CLI paths with a local AWS executable stub, missing/ambiguous/foreign ECR responses, manifest/config/source binding, redirects and bounds. The artifact fixture runs the verification entrypoint with external dependencies isolated and confirms exact manifest bytes. The 16 materialized YAML files are parsed using the installed js-yaml module; all 19 jobs and all four CI caller deltas are inspected, and every other CI field is compared unchanged. These tests do not execute Docker builds, AWS APIs or GitHub Actions.

Reproduce the templates using the reviewed lots source (exact head/hash in proof.json):

```sh
python3 -B scripts/operations/consumer-publishers/render.py \
  --lots /home/nate/Oxy/oxy/.worktrees/1519-consumer-rollout-preflight-20261003/docs/architecture/1519-consumer-rollout-preflight/execution/lots.json \
  --output docs/architecture/1519-consumer-image-publishers \
  --yaml-module /home/nate/Oxy/Mention/node_modules/js-yaml
python3 -B scripts/operations/tests/test-consumer-image-publishers.py
```

No product suites were repeated: this delta adds operator workflow templates and offline fixtures only.
