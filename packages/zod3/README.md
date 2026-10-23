# @oxy.so/zod3

Oxy maintains this same-major source fork of Zod 3.25.76. It preserves the upstream API and advertised subpaths, including embedded `/v3` and `/v4` parsers. It is not an official Zod release.

The backport fixes GHSA-mrhx-c7xc-m3w5 by rejecting oversized **constrained** arrays, sets and maps before traversing their elements. It does not impose a new limit on unconstrained collections. Valid input, lower bounds, transformations, custom messages and paths retain their upstream behavior. Oversized inputs report the upper-bound error without allocating one error per element.

`upstream/provenance.json` identifies the MIT-licensed source archive, its SHA512 and upstream commit. `patches/oversized-collections.patch` contains the complete source changes. `bun run build` verifies the archive, applies the source patch and compiles CJS, ESM and declarations with the repository's locked Zshy/TypeScript toolchain. No downloaded generated runtime is substituted for the compiled source.

`bun run test` checks every advertised parser through CJS, ESM and the source condition. Repository CI also checks the complete installed dependency inventory, upstream negative controls and mutations that restore vulnerable code. Public packages are released only by the shared Actions/OIDC workflow; consumers must receive this package's actual dependency, not an unpropagated repository override.

License and attribution: see `LICENSE`, `NOTICE` and the upstream provenance record.
