import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [tarballDirectory, outputDirectory, ...extra] = process.argv.slice(2);
assert(
  tarballDirectory && outputDirectory && !extra.length,
  'Usage: node test-product-sdk-composition.mjs <packed-directory> <new-consumer-directory>',
);
const packed = path.resolve(tarballDirectory);
const output = path.resolve(outputDirectory);
const relativeToCheckout = path.relative(path.resolve(core, '../..'), output);
assert(
  relativeToCheckout.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToCheckout),
  'Consumer must be outside the checkout so Bun cannot join its workspace',
);
assert(!fs.existsSync(output), 'Use a fresh consumer directory to prevent stale installed bytes');
const packages = ['contracts', 'protocol', 'telemetry', 'core', 'services', 'mcp'];
const tarballs = new Map();
for (const name of packages) {
  const candidates = fs
    .readdirSync(packed)
    .filter((file) => file.startsWith(`oxy.so-${name}-`) && file.endsWith('.tgz'));
  assert.equal(candidates.length, 1, `Expected exactly one packed @oxy.so/${name}`);
  const archive = path.join(packed, candidates[0]);
  const manifest = JSON.parse(
    execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }),
  );
  assert.equal(manifest.name, `@oxy.so/${name}`);
  tarballs.set(manifest.name, archive);
}
fs.cpSync(path.join(core, 'test-consumers/product-sdks'), output, { recursive: true });
const manifestPath = path.join(output, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
// Only platform packages under test are overridden. Product SDKs remain actual
// published consumers; their factories and HTTP implementation are never mocked.
manifest.overrides = Object.fromEntries(
  [...tarballs].map(([name, archive]) => [name, `file:${archive}`]),
);
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const run = (command, args) => execFileSync(command, args, { cwd: output, stdio: 'inherit' });
run('bun', ['install', '--minimum-release-age=0']);
run('bun', ['install', '--frozen-lockfile', '--minimum-release-age=0']);
const requireConsumer = createRequire(manifestPath);
const semver = requireConsumer('semver');
// A tarball override must not hide a product's incompatible declared dependency
// or peer range. Major upgrades require a compatible published product version.
for (const product of Object.keys(manifest.dependencies).filter((name) => !tarballs.has(name))) {
  const productManifest = JSON.parse(
    fs.readFileSync(path.join(output, 'node_modules', product, 'package.json'), 'utf8'),
  );
  for (const section of ['dependencies', 'peerDependencies']) {
    for (const [name, range] of Object.entries(productManifest[section] ?? {})) {
      if (!tarballs.has(name)) continue;
      const installed = JSON.parse(
        fs.readFileSync(path.join(output, 'node_modules', name, 'package.json'), 'utf8'),
      );
      assert(
        semver.satisfies(installed.version, range),
        `${product} requires ${name}@${range}, incompatible with packed ${installed.version}`,
      );
    }
  }
}

let verifiedFiles = 0;
for (const [name, archive] of tarballs) {
  const expected = path.join(output, '.packed', name.replace('/', '-'));
  fs.mkdirSync(expected, { recursive: true });
  execFileSync('tar', ['-xf', archive, '-C', expected]);
  const source = path.join(expected, 'package');
  const installed = path.join(output, 'node_modules', name);
  for (const entry of fs.readdirSync(source, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filename = path.join(entry.parentPath, entry.name);
    const relative = path.relative(source, filename);
    assert.deepEqual(
      fs.readFileSync(path.join(installed, relative)),
      fs.readFileSync(filename),
      `${name}/${relative} must match the tested tarball`,
    );
    verifiedFiles++;
  }
}
run('bun', ['run', 'test']);
run('bun', ['run', 'typecheck']);
run('node', ['-e', "require('@oxy.so/core'); require('@oxy.so/core/server');"]);
run('node', [
  '--input-type=module',
  '-e',
  "await import('@oxy.so/core'); await import('@oxy.so/core/server');",
]);
console.log(
  JSON.stringify({
    productSdkCompositionPassed: true,
    verifiedInstalledFiles: verifiedFiles,
    platformPackages: [...tarballs.keys()],
  }),
);
