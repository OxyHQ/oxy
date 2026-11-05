# Account translations

Edit the original dictionaries in `locales/`. After a change, run
`bun run generate:compact-locales` in `packages/core` and commit the generated
files. `bun run check:compact-locales` verifies that the generated files are
current; the package build and tests run this check automatically.

The public loader imports a compact module per non-English language. Each module
reconstructs its full dictionary from its own data and a private table of
frequently repeated English literals. It does not depend on the mutable English
dictionary, and the original dictionary modules remain present in the package.
