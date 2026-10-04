# Private decisions catalogue composition

The signed Jev catalogue reports `decisions` output. The old sync discarded that
output and skipped the model as `missing_modalities`. This composition preserves
the observed output and derives the decisions API format from an exact, current
private negotiated contract. Ordinary discovery and public admission remain
denied. Request/input modalities stay unchanged.

Source `b3fb09a1426dfb213a8d86bb6a1ab546b585124e` composes inactive Private Auto
`5c07a93`, current main `8a9976a`, and the decisions output fix. Migration 0145
extends the output CHECK and both provenance functions; historical 0050 remains
byte identical. Decisions and text require no fabricated safety marking;
image/audio/video/embedding retain their marking requirement. Fresh source
authority is checked after model locks and before committing an import. A later
genuine text-only import clears only the previously derived decisions format.

The same final publication fixture fails against the old sync (one failure,
five passes). Final owned PostgreSQL validation passes 195 cases in seven
suites, plus 15 focused real HTTP decisions cases. Contracts pass 19 cases.
Canonical API build, ESLint and Biome pass. Normal migration and repeat migration
pass; the owned server is stopped. Draft fixture/setup failures remain preserved
and qualified in `proof.json`.

The 4.10.0 tarball is a provisional candidate, built and packed in the same
command, and has not been published. Its SHA is
`1c727c5e4d3cc31f5ac5988483506256b7635da6e59bc2fb0925046d06e50b53`.
All 200 non-manifest files match the current package bytes. Bun's packed
manifest resolves two development `catalog:` references and serializes Unicode;
the resulting manifest matches those expected transformations exactly.
`candidate-receipt.json` lists every member hash and the source tree.

No AWS, production, provider or publication operation was performed. Auto's
source getter remains absent; this proof does not grant repeated execution or
extend the previously reviewed one-shot audience. Runtime activation, actual
registry publication and production catalogue/legal readbacks belong to the
root operator and remain separate from these local results.
