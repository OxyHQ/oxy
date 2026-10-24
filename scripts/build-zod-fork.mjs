import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? '.');
const provenance = JSON.parse(readFileSync(join(directory, 'upstream/provenance.json'), 'utf8'));
const archive = join(directory, 'upstream', `zod-${provenance.version}.tgz`);
const integrity = `sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`;
if (integrity !== provenance.integrity)
  throw new Error('Pinned Zod source archive integrity mismatch');
const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
if (entries.some((entry) => !entry.startsWith('package/') || entry.split('/').includes('..')))
  throw new Error('Unsafe upstream archive entry');
const temporary = mkdtempSync(join(directory, '.build-'));
try {
  execFileSync('tar', ['-xzf', archive, '-C', temporary]);
  const source = join(temporary, 'package');
  execFileSync(
    'git',
    ['apply', '--check', join(directory, 'patches/oversized-collections.patch')],
    { cwd: source },
  );
  execFileSync('git', ['apply', join(directory, 'patches/oversized-collections.patch')], {
    cwd: source,
  });
  rmSync(join(directory, 'src'), { recursive: true, force: true });
  cpSync(join(source, 'src'), join(directory, 'src'), { recursive: true });
  const require = createRequire(join(directory, 'package.json'));
  execFileSync(process.execPath, [require.resolve('zshy'), '--project', 'tsconfig.build.json'], {
    cwd: directory,
    stdio: 'inherit',
  });
  console.log(
    `Built ${directory} from verified zod@${provenance.version} source plus reviewed collection patch`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
