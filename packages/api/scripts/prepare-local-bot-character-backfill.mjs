#!/usr/bin/env node
// Builds a reviewed, bounded ECS command; does not execute it or contact any service.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const flags = process.argv.slice(2);
const apply = flags.includes('--apply');
const expectedHash = flags.find((flag) => flag.startsWith('--expected-hash='))?.slice(16);
const outputFlag = flags.find((flag) => flag.startsWith('--out='));
if (
  flags.some(
    (flag) =>
      flag !== '--apply' && !flag.startsWith('--expected-hash=') && !flag.startsWith('--out='),
  )
)
  throw new Error('Unknown flag.');
if (apply && !/^[a-f0-9]{64}$/.test(expectedHash ?? ''))
  throw new Error('--apply requires the reviewed --expected-hash=<sha256>.');
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(outputFlag?.slice(6) ?? '.local/avatar-backfill');
const source = readFileSync(
  resolve(packageRoot, 'src/scripts/backfill-local-bot-characters.ts'),
  'utf8',
);
// Bun 1.4.3 Module._compile rejects a shebang even though its file loader accepts it.
// Strip only that interpreter line; the reviewed TypeScript implementation is unchanged.
const compiled = ts
  .transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  })
  .outputText.replace(/^#![^\n]*\n/, '');
const gzip = gzipSync(compiled, { level: 9 });
const sha256 = createHash('sha256').update(compiled).digest('hex');
const options = { apply, ...(apply ? { expectedHash } : {}) };
// Relative requires resolve against the live image's existing dist tree. No files
// are written in that image; the task only evaluates this exact checked payload.
const command = [
  'bun',
  '-e',
  `const z=require('node:zlib'),c=require('node:crypto'),M=require('node:module');const src=z.gunzipSync(Buffer.from('${gzip.toString('base64')}','base64'));if(c.createHash('sha256').update(src).digest('hex')!=='${sha256}')throw Error('Reviewed script hash mismatch');const filename='/app/packages/api/dist/scripts/avatar-backfill-reviewed.cjs',m=new M(filename,module);m.filename=filename;m.paths=M._nodeModulePaths('/app/packages/api');m._compile(src.toString(),filename);const db=require('/app/packages/api/dist/config/postgres.js'),redis=require('/app/packages/api/dist/config/redis.js');(async()=>{await db.connectPostgres();try{process.stdout.write(JSON.stringify({reviewedScriptSHA256:'${sha256}',...await m.exports.backfillLocalBotCharacters(${JSON.stringify(options)})})+'\\n')}finally{await db.closePostgres();await redis.closeRedis()}})().catch(e=>{console.error(e.message);process.exitCode=1});`,
];
const commandJSON = JSON.stringify(command);
// ECS counts the entire overrides JSON. Reserve 2KB for container name and other fields.
if (Buffer.byteLength(commandJSON) > 6144)
  throw new Error('Command exceeds the bounded ECS override budget.');
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, 'script.cjs'), compiled);
writeFileSync(resolve(output, apply ? 'apply-command.json' : 'dry-run-command.json'), commandJSON);
const identity = {
  sha256,
  sourceSHA256: createHash('sha256').update(source).digest('hex'),
  compiledBytes: Buffer.byteLength(compiled),
  gzipBytes: gzip.length,
  commandJSONBytes: Buffer.byteLength(commandJSON),
  options,
};
writeFileSync(resolve(output, 'identity.json'), `${JSON.stringify(identity, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(identity)}\n`);
