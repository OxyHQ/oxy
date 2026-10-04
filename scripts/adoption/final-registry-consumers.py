#!/usr/bin/env python3
"""Apply reviewed manifest patches only after exact registry/member verification.
No commits, pushes, merges, package publishing, images or deployments are performed.
"""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PLAN = ROOT / 'docs/architecture/1519-consumer-rollout-preflight/execution/lots.json'
SDK = {'@oxy.so/contracts', '@oxy.so/core', '@oxy.so/services', '@oxy.so/mcp', '@oxy.so/protocol'}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def command(args, cwd, timeout=30):
    return subprocess.check_output(args, cwd=cwd, text=True, stderr=subprocess.PIPE, timeout=timeout).strip()


def member_hashes(data):
    result = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for item in archive:
            path = PurePosixPath(item.name)
            require(not path.is_absolute() and '..' not in path.parts and path.parts[0] == 'package', 'Unsafe archive path')
            if item.isdir():
                continue
            require(item.isfile() and item.size <= 64 * 1024 * 1024, 'Unsupported archive member')
            name = '/'.join(path.parts[1:])
            require(name and name not in result, 'Duplicate archive member')
            result[name] = sha(archive.extractfile(item).read())
    require(result and 'package.json' in result, 'Package archive missing manifest')
    return result


class RegistryRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        require(urllib.parse.urlparse(newurl).scheme == 'https' and urllib.parse.urlparse(newurl).hostname == 'registry.npmjs.org', 'Foreign registry redirect')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url, limit):
    parsed = urllib.parse.urlparse(url)
    require(parsed.scheme == 'https' and parsed.hostname == 'registry.npmjs.org' and not parsed.username, 'Registry origin differs')
    with urllib.request.build_opener(RegistryRedirects).open(url, timeout=40) as response:
        value = response.read(limit + 1)
    require(len(value) <= limit, 'Registry response exceeds bound')
    return value


def verify_registry(plan, candidate_manifest, output):
    candidates = {item['name']: item for item in candidate_manifest}
    records = []
    # Complete all five verifications BEFORE changing any consumer.
    for name in sorted(SDK):
        version = plan['targetVersions'][name]
        candidate = candidates[name]
        require(candidate['version'] == version and candidate['source'] == plan['sdkCandidate'], 'Candidate pin differs')
        candidate_bytes = Path(candidate['path']).read_bytes()
        require(sha(candidate_bytes) == candidate['sha256'], 'Candidate archive changed')
        raw = download('https://registry.npmjs.org/' + urllib.parse.quote(name, safe='') + '/' + version, 4 * 1024 * 1024)
        metadata = json.loads(raw)
        require(metadata['name'] == name and metadata['version'] == version, 'Registry version differs')
        archive = download(metadata['dist']['tarball'], 128 * 1024 * 1024)
        integrity = 'sha512-' + base64.b64encode(hashlib.sha512(archive).digest()).decode()
        require(integrity in metadata['dist']['integrity'].split(), 'Registry integrity differs')
        members = member_hashes(archive)
        require(members == member_hashes(candidate_bytes), 'Published shipping files differ from reviewed candidate')
        record = {'name': name, 'version': version, 'sha256': sha(archive), 'integrity': integrity,
                  'files': len(members), 'candidateSha256': candidate['sha256'], 'allFilesEqual': True}
        write(output / (name.rsplit('/', 1)[1] + '-registry.json'), record)
        records.append(record | {'memberHashes': members})
    return records


def write(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, indent=2); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())


def preflight(row, check_main=False):
    wt = Path(row['worktree'])
    require(command(['git', 'rev-parse', 'HEAD'], wt) == row['preparedHead'], 'Consumer HEAD changed: ' + row['repository'])
    require(command(['git', 'branch', '--show-current'], wt) == row['branch'], 'Consumer branch changed')
    patch = ROOT / row['manifestPatch']['path']
    require(sha(patch.read_bytes()) == row['manifestPatch']['sha256'], 'Manifest patch changed')
    for change in row['manifestPatch']['changes']:
        require(sha((wt / change['path']).read_bytes()) == change['before'], 'Manifest input changed: ' + row['repository'] + '/' + change['path'])
    command(['git', 'apply', '--check', str(patch)], wt)
    current_main = None
    if check_main:
        remote = command(['git', 'ls-remote', 'origin', 'refs/heads/main'], wt).split()
        require(len(remote) == 2 and remote[1] == 'refs/heads/main', 'Main discovery failed')
        current_main = remote[0]
        command(['git', 'fetch', '--no-write-fetch-head', 'origin', current_main], wt, 120)
        try:
            command(['git', 'merge-base', '--is-ancestor', current_main, row['preparedHead']], wt)
        except subprocess.CalledProcessError as error:
            raise RuntimeError('Main advanced; preserve/rebase reviewed source before adoption: ' + row['repository']) from error
    return {'repository': row['repository'], 'head': row['preparedHead'], 'currentMain': current_main, 'patchSha256': row['manifestPatch']['sha256']}


def importer_manifests(wt):
    root = wt / 'package.json'
    data = json.loads(root.read_text())
    workspaces = data.get('workspaces', [])
    patterns = workspaces.get('packages', []) if isinstance(workspaces, dict) else workspaces
    manifests = {root}
    for pattern in patterns:
        require(isinstance(pattern, str) and not Path(pattern).is_absolute() and '..' not in Path(pattern).parts, 'Invalid workspace pattern')
        manifests.update(p for p in wt.glob(pattern.rstrip('/') + '/package.json') if p.is_file())
    return sorted(manifests)


def verify_installed(row, registry):
    wt = Path(row['worktree']).resolve()
    expected = {item['name']: item for item in registry}
    importer_files = importer_manifests(wt)
    receipts = []
    verified = {}
    pending = [(manifest, True) for manifest in importer_files]
    resolver = """const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const [manifest,name]=process.argv.slice(1);const req=createRequire(manifest);let entry;
try{entry=req.resolve(name)}catch(e){
 const present=(req.resolve.paths(name)||[]).some(base=>{try{fs.lstatSync(path.join(base,name));return true}catch(x){if(x.code==='ENOENT')return false;throw x}});
 if(e.code==='MODULE_NOT_FOUND'&&!present){process.stdout.write('null');process.exit(0)}throw e;
}
let p=path.dirname(entry);
while(p!=='/'&&(!fs.existsSync(path.join(p,'package.json'))||JSON.parse(fs.readFileSync(path.join(p,'package.json'))).name!==name))p=path.dirname(p);
if(p==='/')process.exit(2);process.stdout.write(JSON.stringify(fs.realpathSync(p)));"""
    while pending:
        manifest, consumer = pending.pop(0)
        data = json.loads(manifest.read_text())
        sections = ['dependencies', 'peerDependencies', 'optionalDependencies']
        if consumer:
            sections.append('devDependencies')
        names = set().union(*(data.get(section, {}) for section in sections))
        for name in sorted(names & SDK):
            require(len(receipts) < 8192, 'SDK dependency edge bound exceeded')
            require(name in expected, 'SDK dependency lacks verified registry artifact: ' + name)
            kinds = [section for section in sections if name in data.get(section, {})]
            optional = all(section == 'optionalDependencies' or
                           (section == 'peerDependencies' and data.get('peerDependenciesMeta', {}).get(name, {}).get('optional') is True)
                           for section in kinds)
            importer = str(manifest.relative_to(wt)) if manifest.is_relative_to(wt) else str(manifest)
            edge = {'importer': importer, 'parentPackage': data.get('name'), 'name': name, 'dependencyTypes': kinds}
            resolved = json.loads(command(['node', '-e', resolver, str(manifest), name], wt))
            if resolved is None:
                require(optional, 'Required SDK dependency is absent: ' + name)
                receipts.append(edge | {'status': 'optional-absent', 'root': None, 'files': 0})
                continue
            path = Path(resolved)
            if path not in verified:
                require(len(verified) < 1024, 'SDK package node bound exceeded')
                installed = json.loads((path / 'package.json').read_text())
                require(installed['name'] == name and installed['version'] == expected[name]['version'], 'Installed package version differs')
                for rel, digest in expected[name]['memberHashes'].items():
                    require(sha((path / rel).read_bytes()) == digest, 'Installed member differs from published archive')
                verified[path] = installed
                # Installed SDK development dependencies do not belong to its runtime graph.
                pending.append((path / 'package.json', False))
            installed = verified[path]
            require(installed['name'] == name, 'Resolved SDK package identity differs')
            receipts.append(edge | {'status': 'verified', 'version': installed['version'], 'root': str(path), 'files': len(expected[name]['memberHashes']), 'allFilesEqual': True})
    require(verified, 'No SDK importer verified')
    return receipts


def install(row, output, registry):
    wt = Path(row['worktree'])
    patch = ROOT / row['manifestPatch']['path']
    command(['git', 'apply', str(patch)], wt)
    for change in row['manifestPatch']['changes']:
        require(sha((wt / change['path']).read_bytes()) == change['after'], 'Applied manifest differs')
    # Only install lifecycle scripts run, as in the reviewed package commands.
    # No generic release/build/deploy/publish script is inferred or invoked.
    for label, args in [('resolve', ['bun', 'install', '--minimum-release-age=0']),
                        ('frozen', ['bun', 'install', '--frozen-lockfile', '--minimum-release-age=0'])]:
        path = output / (row['repository'].split('/')[1] + '-' + label + '.log')
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'w') as log:
            result = subprocess.run(args, cwd=wt, stdout=log, stderr=subprocess.STDOUT, timeout=1200)
        require(result.returncode == 0, 'Consumer install failed; preserve partial state and log')
    for change in row['manifestPatch']['changes']:
        require(sha((wt / change['path']).read_bytes()) == change['after'], 'Install mutated reviewed manifest')
    return {'repository': row['repository'], 'lockSha256': sha((wt / 'bun.lock').read_bytes()),
            'installed': True, 'installedMembers': verify_installed(row, registry), 'acceptanceChecksPending': row['packageScripts'], 'merged': False, 'deployed': False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--plan', type=Path, default=DEFAULT_PLAN)
    parser.add_argument('--repository', action='append', required=True, help='Exact OxyHQ/name; repeat for a batch')
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--candidate-manifest', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text())
    require(len(set(args.repository)) == len(args.repository), 'Duplicate repository')
    rows = [row for row in plan['consumers'] if row['repository'] in args.repository]
    require(len(rows) == len(args.repository), 'Unknown repository')
    args.output.mkdir(mode=0o700, parents=False, exist_ok=False)
    write(args.output / 'intent.json', {'planSha256': sha(args.plan.read_bytes()), 'execute': args.execute, 'repositories': args.repository})
    try:
        records = [preflight(row, check_main=args.execute) for row in rows]
        write(args.output / 'preflight.json', records)
        if not args.execute:
            print('PREFLIGHT_ONLY: no consumer edits, registry lookup, install or deployment'); return
        require(args.candidate_manifest is not None, 'Reviewed candidate manifest required')
        registry = verify_registry(plan, json.loads(args.candidate_manifest.read_text()), args.output)
        write(args.output / 'registry.json', registry)
        for row in rows:
            # Recheck immediately before each mutation after potentially long registry work.
            preflight(row, check_main=True)
            write(args.output / (row['repository'].split('/')[1] + '-installed.json'), install(row, args.output, registry))
        print('REGISTRY_INSTALL_COMPLETE: acceptance checks, commit and root deployment remain pending')
    except Exception as error:
        write(args.output / 'failed.json', {'kind': type(error).__name__, 'partialStatePreserved': True, 'automaticRetry': False})
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('ADOPTION_STOPPED: inspect private receipts; no automatic rollback/retry', file=os.sys.stderr)
        raise SystemExit(1)
