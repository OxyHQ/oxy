#!/usr/bin/env python3
"""Read-only I11 evidence validation and dependency review proposals (no updates)."""
import argparse
import concurrent.futures
import json
import pathlib
import re
import subprocess
import sys

SNAPSHOT = pathlib.Path(__file__).resolve().parent.parent / 'docs/audits/2026-10-02-i11-ecosystem-coverage.json'


def gh_json(endpoint):
    return json.loads(subprocess.check_output(['gh', 'api', endpoint], text=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', type=pathlib.Path, default=SNAPSHOT)
    parser.add_argument('--online', action='store_true', help='Check current accessible repo set and default heads; never mutate')
    parser.add_argument('--json', action='store_true', help='Emit the validation and review proposals as JSON')
    args = parser.parse_args()
    data = json.loads(args.snapshot.read_text())
    rows = data['repositories']
    errors = []
    names = [row['repository'] for row in rows]
    if len(names) != 50 or len(set(names)) != 50:
        errors.append('Expected exactly 50 distinct repositories for this dated snapshot')
    registry = {(record['package'], record['requested_version']): record for record in data['registry_observations']}
    latest = {record['package']: record for record in data['registry_observations'] if record['requested_version'] == 'latest'}
    proposals = []
    for row in rows:
        name = row['repository']
        if not re.fullmatch('[0-9a-f]{40}', row['head']):
            errors.append(f'{name}: invalid source head')
        if row['tree_truncated'] or not row['evidence'] or not row['reason']:
            errors.append(f'{name}: incomplete provenance or classification evidence')
        if row['classification'] not in ['direct', 'indirect', 'planned', 'unaffected']:
            errors.append(f'{name}: invalid classification')
        evidence = {record['path']: record for record in row['evidence']}
        for path in row['primary_evidence']:
            if path not in evidence:
                errors.append(f'{name}: primary source {path} was not inspected')
        for record in row['evidence']:
            if not re.fullmatch('[0-9a-f]{40}', record['blob_sha']) or row['head'] not in record['url']:
                errors.append(f'{name}: source pin mismatch {record["path"]}')
            if not (1 <= record['focus_line'] <= record['lines']):
                errors.append(f'{name}: invalid source line {record["path"]}')
        for record in row['declared'] + row['resolved']:
            source = evidence.get(record['path'])
            if source is None or not (1 <= record['line'] <= source['lines']):
                errors.append(f'{name}: dependency evidence missing {record["path"]}')
        for record in row['resolved']:
            if record['kind'] == 'workspace-source':
                if not record['version'].startswith('workspace:'):
                    errors.append(f'{name}: workspace version classified as registry')
                continue
            published = registry.get((record['package'], record['version']))
            if not published or published['status'] != 'published-registry-metadata' or not published.get('integrity'):
                errors.append(f'{name}: exact publication metadata unconfirmed {record["package"]}@{record["version"]}')
        if row['deployed']['status'] != 'not-verified' or row['deployed']['evidence'] is not None:
            errors.append(f'{name}: this source snapshot cannot certify deployment')
        for declared in row['declared']:
            pkg = declared['package']
            if pkg not in latest or str(declared['effective_declared']).startswith(('workspace:', '*')):
                continue
            locked = sorted({record['version'] for record in row['resolved'] if record['package'] == pkg and record['kind'] == 'locked-registry-package'})
            target = latest[pkg]['version']
            if not locked or locked == [target]:
                continue
            manifest = next(record for record in row['test_commands'] if record['path'] == declared['path'])
            script = manifest['test_script']
            noop = script is None or 'No tests specified' in script or 'No tests' in script
            proposals.append({
                'repository': name, 'manifest': declared['path'], 'package': pkg,
                'declared': declared['declared'], 'effective_declared': declared['effective_declared'],
                'locked_versions': locked, 'observed_latest': target,
                'major_change': any(version.split('.')[0] != target.split('.')[0] for version in locked),
                'test_command': None if noop else f'cd {str(pathlib.PurePosixPath(declared["path"]).parent)} && bun run test',
                'test_script': script, 'test_coverage_gap': noop,
                'action': 'review only; approved contract target, semver, package tests, lock sync and runtime adoption required',
            })
    drift = []
    if args.online:
        current = []
        page = 1
        while True:
            batch = gh_json(f'orgs/{data["organization"]}/repos?per_page=100&page={page}')
            current.extend(batch)
            if len(batch) < 100:
                break
            page += 1
        current_names = {repo['name'] for repo in current}
        if current_names != set(names):
            errors.append(f'Repository set drift: added={sorted(current_names-set(names))}, missing={sorted(set(names)-current_names)}')
        def check_head(row):
            commit = gh_json(f'repos/{data["organization"]}/{row["repository"]}/commits/{row["default_branch"]}')
            return row['repository'], row['head'], commit['sha']
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            for name, pinned, head in pool.map(check_head, rows):
                if head != pinned:
                    drift.append({'repository': name, 'pinned': pinned, 'current_head': head})
        if drift:
            errors.append('Default head drift; re-inspect changed sources before final adoption')
    result = {'scope': 'source/registry evidence only; runtime acceptance remains pending', 'repositories': len(rows),
              'inspected_files': sum(len(row['evidence']) for row in rows), 'locked_records': sum(len(row['resolved']) for row in rows),
              'errors': errors, 'head_drift': drift, 'review_proposals': proposals}
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f'I11 source snapshot: {len(rows)} repos, {result["inspected_files"]} inspected files, {result["locked_records"]} lock records')
        print(f'{len(proposals)} read-only version-gap proposals; runtime/semver acceptance is not certified')
        for error in errors:
            print('ERROR:', error, file=sys.stderr)
        for proposal in proposals:
            flag = 'major review' if proposal['major_change'] else 'compatibility review'
            print(f'{proposal["repository"]}/{proposal["manifest"]}: {proposal["package"]} {proposal["locked_versions"]} -> observed {proposal["observed_latest"]} ({flag}; tests {proposal["test_command"] or "missing/no-op"})')
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
