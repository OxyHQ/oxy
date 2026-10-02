# Unapproved Forge 1.4.0 candidate

This is preparation for independent security review. It does not establish advisory remediation, change the audit gate, or authorize deployment. The package version remains 1.4.0.

The candidate adds nested DigestAlgorithm arity and empty-NULL checks after successful ASN.1 validation and the existing outer two-child check. It covers lib/rsa.js and both shipped RSA-containing browser bundles. Both maps were regenerated with the official configuration and remain byte-identical to their original single-mapping maps. The prime worker does not include RSA and is unchanged.

Reproduction: clone digitalbazaar/forge tag v1.4.0 at fa385f92440879601240020f158bed68e444e83a, copy toolchain.bun.lock to bun.lock, and run Bun 1.4.2 install --frozen-lockfile --minimum-release-age=0 --ignore-scripts. Apply only the lib/rsa.js hunk of patches/node-forge@1.4.0.patch, then bun run build using the unchanged webpack.config.js (webpack 4.47.0, webpack-cli 3.3.12). Hashes in candidate-hashes.json pin the stock and candidate files. Rebuilding stock source matched both official bundles/maps exactly; rebuilding candidate twice matched all five files.

Upstream full unit/security suite: NODE_ENV=test node node_modules/mocha/bin/mocha -t 30000 -R dot tests/unit/index.js, 828 passing / 4 pending. Upstream tests/unit/jsbn.js contains describe.only; remove that marker only in the temporary test checkout or the advertised suite executes just five tests. No test-source modification is shipped in the package patch.

Frozen whole-workspace installation matched every materialized Forge copy to all five candidate hashes. The existing API production dependency fixture passed. Docker manifest transport and portable production fixture both copy declared patch files before frozen installation. Lock synchronization checks reject a changed declaration, absent patch, or escaped path. Independent adversarial tests, Expo signing compatibility, image-byte proof and security review remain separate required gates. Bun audit remains version-based and still reports the advisory.
