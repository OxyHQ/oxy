# I05 original-criteria acceptance

The approved Alia/Mention pilot uses published contracts4.9.0, core4.2.0,
protocol1.2.2 and MCP1.1.0. Installed members, lockfiles and immutable images were
accepted separately in the final consumer proofs. Root verified the canonical
five-credential authority/CAS and catalog readbacks, retired the owned ephemeral
credential, and then accepted Mention486 and Alia450: exact single environment
changes, unchanged images/roles/secrets, healthy tasks/targets and readiness200.
Infrastructure PR254 main409be1f persists these public bindings; it is source
persistence, not a claim that Terraform applied the runtime changes.

| Original criterion | Evidence |
|---|---|
| Pilot consumers migrated with explicit versions | Final Alia34760/Mention513e registry proofs plus root image adoption. Alia450 sets only `ALIA_INTERNAL_MCP_PILOT=mention`; Mention486 binds exact canonical registration/version/digest from the accepted full-five readback. Other adapters retain their prior transport. |
| Preserve ticket, tool, catalog, account and backend guarantees | Alia's real tool adapter uses the installed common client, preserves requester and operation identity and checks approved catalog provenance. Mention's common receiver reuses the actual registry, handlers and backend authorization. Signed wrong tool/account/catalog, ordinary Bearer, stale authority and missing operation key are refused before effects. OAuth remains a distinct verified lane. |
| Input/result/error parity across legacy HTTP, internal MCP and external MCP | Complementary contract tests: Alia's actual tool with installed SDK over loopback HTTP; Mention's actual common receiver, savePost controller and PostgreSQL; legacy Capability HTTP and external MCP registry/formatter/HTTP suites. Mention tests compare the shared domain handler and preserve its refusal. External tool parity exercises the same registry and request shapes with controlled backend responses. No single cross-repository Alia→Mention process with SQL is claimed. |
| Replay creates no second effect; a deliberate new request is distinct | Mention's SQL fixture produces one bookmark, refuses duplicate/conflicting operation keys and records two receipts for two deliberate operation keys. Audit keys remain correlated. Alia verifies stable keys, errors and final retirement. Acknowledged success survives retirement failure; cleanup-only retries cannot create another effect, and transport-unknown remains distinct from success. |
| Retire the old endpoint only if legitimate callers no longer need it | `/_oxy/capabilities` is deliberately retained as the compatibility lane. It is not deleted based on the pilot. The non-Mention Alia adapters still select the existing HTTP branch. No claim is made that a global caller census permits deleting the endpoint. This satisfies the original explicit option to justify retention. |
| Deliver product PRs, adopted versions and joint evidence | Alia662/663 and final Mention1309 preserve source/CI history; final manifests/locks, member proofs and runtime acceptance are indexed here. The tests jointly cover the common contract across consumer and receiver while keeping their synthetic authority/storage boundaries explicit. |

The receiver SQL evidence uses the real write controller and durable effect
receipts; its remote Oxy authority is synthetic. Alia's loopback fixture uses the
real tool adapter and installed common MCP client but synthetic effect storage.
The external parity suite controls backend HTTP responses. Those scopes are
complementary, not relabelled as one end-to-end production user operation.
Deployment probes establish serving configuration; they do not prove a new human
consent, grant or write. None was fabricated for acceptance.

Original CAS failures (old owner assumption, incomplete two-versus-five census,
transport/readback failures) remain in their historical evidence. Full-five
readback verified preservation of existing authority and cleanup. Two subsequent
conditional preflight-helper findings (effective scope and ISO dates), their fix
and Forge reactivation are tracked separately in PR1569/I11; these unsafe input
conditions were not the five actual approved records. This acceptance does not
claim that pending helper fixes or Forge work are merged.
