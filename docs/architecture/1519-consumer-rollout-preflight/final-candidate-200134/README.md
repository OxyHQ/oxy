# Final-source comparison packs

All seven packages built and packed from clean, isolated source `20013421a4cc07545a7685931db68f4ee55f1773`. Each package ran `bun run build && bun pm pack` in the same command. Frozen install and exact build/pack logs are retained; archive locations, SHA256, package source trees, member counts and canonical member-hash digests are in `proof.json`.

These are candidate comparison artifacts, not published releases. Root's coordinated publisher must build and pack freshly from its reviewed release source before publishing and compare all archive members against these candidates. Archive gzip/tar metadata may differ; content equality is the comparison. Backend readiness precedes publication. Telemetry1.2.0 already exists in registry; utils was built only as a prerequisite. This checkpoint does not publish or overwrite either.

Historical source1b consumer proofs remain historical; these packs replace them only for final-source byte comparison. Final registry integrity/readback, consumer installs/locks and runtime acceptance remain separate gates.
