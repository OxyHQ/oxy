/**
 * Test the published MCP dependency graph outside the monorepo. Root overrides
 * do not reach consumers. A loopback registry serves the built workspace bytes
 * so this gate also works before their first official release.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'oxy-mcp-package-'));

async function run(command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: 'inherit' });
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, 0, `${command} ${args.join(' ')} failed (${signal ?? code})`);
}

const packages = new Map();
const tarballs = new Map();
const registry = createServer((request, response) => {
  const path = decodeURIComponent(request.url ?? '/');
  const bytes = tarballs.get(path);
  const manifest = packages.get(path.slice(1));
  if (bytes) {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    response.end(bytes);
  } else if (manifest) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        name: manifest.name,
        'dist-tags': { latest: manifest.version },
        versions: { [manifest.version]: manifest },
      }),
    );
  } else {
    response.writeHead(404);
    response.end();
  }
});

try {
  registry.listen(0, '127.0.0.1');
  await once(registry, 'listening');
  const registryUrl = `http://127.0.0.1:${registry.address().port}`;
  for (const name of ['zod3', 'zod4', 'contracts', 'mcp']) {
    const directory = join(root, 'packages', name);
    const destination = join(temporary, 'tarballs', name);
    await mkdir(destination, { recursive: true });
    await run('bun', ['pm', 'pack', '--destination', destination], directory);
    const files = (await readdir(destination)).filter((file) => file.endsWith('.tgz'));
    assert.equal(files.length, 1);
    const tarball = join(destination, files[0]);
    const bytes = await readFile(tarball);
    const unpacked = join(destination, 'unpacked');
    await mkdir(unpacked);
    await run('tar', ['-xzf', tarball, '-C', unpacked], directory);
    const manifest = JSON.parse(await readFile(join(unpacked, 'package/package.json'), 'utf8'));
    const path = `/tarballs/${name}.tgz`;
    tarballs.set(path, bytes);
    packages.set(manifest.name, {
      ...manifest,
      dist: {
        tarball: `${registryUrl}${path}`,
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      },
    });
  }

  const fork = packages.get('@oxy.so/zod4');
  const mcp = packages.get('@oxy.so/mcp');
  assert.equal(mcp.dependencies.zod, `npm:${fork.name}@${fork.version}`);
  for (const manager of ['npm', 'bun']) {
    const consumer = join(temporary, manager);
    await mkdir(consumer);
    await writeFile(join(consumer, '.npmrc'), `@oxy.so:registry=${registryUrl}\n`);
    await writeFile(
      join(consumer, 'package.json'),
      JSON.stringify({
        name: 'oxy-isolated-mcp-consumer',
        version: '1.0.0',
        private: true,
        dependencies: { '@oxy.so/mcp': mcp.version },
      }),
    );
    await run(
      manager,
      manager === 'npm'
        ? ['install', '--ignore-scripts', '--no-audit', '--no-fund']
        : ['install', '--ignore-scripts', '--minimum-release-age=0'],
      consumer,
    );
    await writeFile(
      join(consumer, 'probe.cjs'),
      `
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const fromOxy = createRequire(require.resolve('@oxy.so/mcp'));
const fromSdk = createRequire(fromOxy.resolve('@modelcontextprotocol/sdk/server/mcp.js'));
const fromConverter = createRequire(fromSdk.resolve('zod-to-json-schema'));
for (const [name, resolver] of [['MCP SDK', fromSdk], ['JSON schema converter', fromConverter]]) {
  const manifest = resolver('zod/package.json');
  assert.equal(manifest.name, ${JSON.stringify(fork.name)}, name);
  assert.equal(manifest.version, ${JSON.stringify(fork.version)}, name);
  const { z } = resolver('zod/v3');
  let parsed = 0;
  const result = z.array(z.string().superRefine(() => { parsed++; })).max(1)
    .safeParse(Array(1000).fill('valid'));
  assert.equal(result.success, false);
  assert.equal(result.error.issues.length, 1);
  assert.equal(parsed, 0, name + ' must reject oversize input before child parsing');
}
const { McpServer } = fromOxy('@modelcontextprotocol/sdk/server/mcp.js');
const server = new McpServer({ name: 'isolated-package-check', version: '1' });
const oxy = require('@oxy.so/mcp');
const schema = oxy.jsonSchemaToZod({ type: 'string', minLength: 1 });
assert.equal(schema.safeParse('valid').success, true);
assert.equal(schema.safeParse('').success, false);
server.registerTool('probe', { inputSchema: { value: schema } }, async () => ({ content: [] }));
console.log('Packed MCP: maintained dependency closure and embedded v3 bound verified');
`,
    );
    await run('node', ['probe.cjs'], consumer);
  }
} finally {
  await new Promise((resolveClose) => registry.close(resolveClose));
  await rm(temporary, { recursive: true, force: true });
}
