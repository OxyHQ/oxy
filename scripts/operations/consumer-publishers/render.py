"""Render closed per-repository manual publishers from the reviewed rollout recipes."""
import argparse
import hashlib
import json
import re
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
CACHE = {'mention': 'mention-backend', 'mention-mcp': 'mention-mcp', 'mercaria': 'mercaria-backend', 'clarity-api': 'clarity-backend', 'allo': 'allo', 'noted': 'noted-backend', 'homiio': 'homiio-api', 'homiio-worker': 'homiio-worker', 'website-api': 'website-api', 'peable': 'peable-backend', 'tnp-api': 'tnp-api', 'willo': 'willo-backend', 'goway': 'goway-backend', 'moovo': 'moovo-backend', 'nilo': 'nilo-api', 'crowdsource': 'crowdsource-backend', 'syra': 'syra-backend'}
ACTIONS = {'checkout': 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'credentials': 'aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd', 'login': 'aws-actions/amazon-ecr-login@03f1aad4c6c7ffd436567f42f9384779290529bd', 'buildx': 'docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069', 'build': 'docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc', 'artifact': 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'}


def workflow(repository, recipes):
    role = {'OxyHQ/Clarity': 'oxy-clarity-github-deploy', 'OxyHQ/GoWay': 'oxy-goway-github-deploy'}.get(repository, 'oxy-github-deploy')
    jobs = {}
    for r in recipes:
        name = r['name']
        guard = ['python3', '-B', '.github/scripts/publish-reviewed-image.py']
        command = lambda phase: ' '.join(guard + [phase, '--recipe', name])
        labels = '\n'.join(['org.opencontainers.image.revision=${{ github.sha }}', 'org.opencontainers.image.source=https://github.com/' + repository, 'io.oxy.source.tree=${{ steps.guard.outputs.source_tree }}', 'io.oxy.dockerfile.sha256=' + r['dockerfileSha256']])
        build = {'context': '.', 'file': r['dockerfile'], 'platforms': 'linux/arm64', 'push': True, 'provenance': False, 'sbom': False, 'tags': '237343248947.dkr.ecr.us-west-2.amazonaws.com/' + r['ecrRepository'] + ':${{ github.sha }}' + r['tagSuffix'], 'labels': labels}
        if r['target']: build['target'] = r['target']
        if r['cacheScope']:
            build['cache-from'] = 'type=gha,scope=' + r['cacheScope']
            build['cache-to'] = 'type=gha,mode=max,scope=' + r['cacheScope']
        jobs[name] = {'if': "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.repository == '" + repository + "'", 'runs-on': 'ubuntu-24.04-arm', 'timeout-minutes': 45, 'permissions': {'contents': 'read', 'id-token': 'write'}, 'env': {'EXPECTED_SOURCE_SHA': '${{ inputs.expected_source_sha }}', 'AWS_REGION': 'us-west-2', 'DOCKER_BUILD_RECORD_UPLOAD': 'false'}, 'steps': [
            {'name': 'Checkout immutable source', 'uses': ACTIONS['checkout'], 'with': {'ref': '${{ github.sha }}', 'persist-credentials': False}},
            {'name': 'Guard reviewed main source', 'id': 'guard', 'run': command('guard')},
            {'name': 'Authenticate existing publisher role', 'uses': ACTIONS['credentials'], 'with': {'role-to-assume': 'arn:aws:iam::237343248947:role/' + role, 'aws-region': 'us-west-2', 'role-session-name': 'image-only-${{ github.run_id }}', 'allowed-account-ids': '237343248947'}},
            {'name': 'Refuse existing source tag', 'run': command('vacancy')},
            {'name': 'Login to ECR', 'uses': ACTIONS['login'], 'with': {'mask-password': True}},
            {'name': 'Setup native ARM builder', 'uses': ACTIONS['buildx']},
            {'name': 'Build and publish exact source image', 'id': 'build', 'uses': ACTIONS['build'], 'with': build},
            {'name': 'Verify authenticated ECR bytes', 'id': 'verify', 'env': {'BUILD_METADATA': '${{ steps.build.outputs.metadata }}'}, 'run': command('verify')},
            {'name': 'Retain source image proof', 'uses': ACTIONS['artifact'], 'with': {'name': 'reviewed-image-' + name + '-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}', 'path': '${{ steps.verify.outputs.proof_path }}', 'if-no-files-found': 'error', 'retention-days': 14}}
        ]}
    return {'name': 'Publish reviewed ARM images only', 'on': {'workflow_dispatch': {'inputs': {'expected_source_sha': {'description': 'Exact reviewed full SHA currently on main', 'required': True, 'type': 'string'}}}}, 'permissions': {'contents': 'read'}, 'concurrency': {'group': 'reviewed-image-publication-${{ github.repository }}', 'cancel-in-progress': False}, 'jobs': jobs}


def hold_callers(raw, names):
    text = raw.decode()
    for name in names:
        pattern = r'(?m)^  ' + re.escape(name) + r':\n(?:(?!^  [a-zA-Z0-9_-]+:).|\n)*'
        match = re.search(pattern, text)
        assert match, 'Caller job missing: ' + name
        block = match.group()
        condition = re.search(r'(?m)^    if: (.+)(?:\n      [^\n]*)*', block)
        assert condition, 'Caller condition missing'
        original = condition.group()[8:].strip()
        if original.startswith('>-'):
            original = original[2:].strip()
        if original.startswith('${{'):
            assert original.endswith('}}')
            original = original[3:-2].strip()
        replacement = "    if: >-\n      ${{ vars.OXY_1519_ROLLOUT_HOLD != 'true' && (" + original + ") }}"
        updated = block[:condition.start()] + replacement + block[condition.end():]
        text = text[:match.start()] + updated + text[match.end():]
    return text.encode()

def render(lots_path, output, yaml_module):
    raw = lots_path.read_bytes()
    lots = json.loads(raw)
    manifest = {'kind': 'consumer-image-publisher-templates', 'schemaVersion': 1, 'lotsSha256': hashlib.sha256(raw).hexdigest(), 'effects': 'unapplied templates; no builds, registry writes or deployments', 'excludedServices': ['tnp-dns'], 'repositories': []}
    for consumer in lots['consumers']:
        recipes = []
        for r in consumer['imageRecipes']:
            if r['service'] == 'tnp-dns': continue
            existing = next((x for x in recipes if (x['ecrRepository'], x['dockerfile'], x['target']) == (r['ecrRepository'], r['dockerfile'], r['target'])), None)
            if existing:
                existing['services'].append(r['service']); continue
            recipes.append({'name': r['service'], 'services': [r['service']], 'ecrRepository': r['ecrRepository'], 'dockerfile': r['dockerfile'], 'dockerfileSha256': r['dockerfileSha256'], 'target': r['target'], 'tagSuffix': '-' + r['target'] if r['target'] else '', 'cacheScope': CACHE.get(r['service'])})
        if not recipes: continue
        repo = consumer['repository']
        directory = output / repo.split('/')[1]
        files = {'.github/scripts/publish-reviewed-image.py': (ROOT / 'publish-reviewed-image.py').read_bytes(), '.github/scripts/reviewed-images.json': (json.dumps({'repository': repo, 'recipes': recipes}, indent=2) + '\n').encode()}
        obj = workflow(repo, recipes)
        result = subprocess.run(['node', '-e', "const y=require(process.argv[1]);let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(y.dump(JSON.parse(s),{lineWidth:-1,noRefs:true})));", yaml_module], input=json.dumps(obj).encode(), capture_output=True, check=True)
        files['.github/workflows/publish-reviewed-images.yml'] = result.stdout
        callers = {'OxyHQ/GoWay': ['deploy', 'deploy-frontend'], 'OxyHQ/Homiio': ['deploy-backend'], 'OxyHQ/tnp': ['publish_aws_images']}.get(repo, [])
        if callers:
            original_ci = subprocess.check_output(['git', '-C', consumer['worktree'], 'show', consumer['preparedHead'] + ':.github/workflows/ci.yml'])
            files['.github/workflows/ci.yml'] = hold_callers(original_ci, callers)
        for path, content in files.items():
            target = directory / path; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(content)
        # Pin source inputs, not local mutable worktree contents.
        pins = []
        paths = {r['dockerfile'] for r in recipes} | {w['path'] for w in consumer['workflows']}
        if callers: paths.add('.github/workflows/ci.yml')
        for path in sorted(paths):
            content = subprocess.check_output(['git', '-C', consumer['worktree'], 'show', consumer['preparedHead'] + ':' + path])
            pins.append({'path': path, 'sha256': hashlib.sha256(content).hexdigest()})
        for r in recipes:
            assert next(p['sha256'] for p in pins if p['path'] == r['dockerfile']) == r['dockerfileSha256']
        manifest['repositories'].append({'repository': repo, 'preparedHead': consumer['preparedHead'], 'lot': consumer['lot'], 'recipes': recipes, 'heldCallerJobs': callers, 'sourceInputs': pins, 'files': [{'source': str(Path(repo.split('/')[1]) / p), 'destination': p, 'sha256': hashlib.sha256(b).hexdigest()} for p, b in files.items()], 'dispatch': ['gh', 'workflow', 'run', 'publish-reviewed-images.yml', '--repo', repo, '--ref', 'main', '-f', 'expected_source_sha=<reviewed-merged-full-SHA>']})
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')


if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--lots', required=True, type=Path); p.add_argument('--output', required=True, type=Path); p.add_argument('--yaml-module', required=True)
    a = p.parse_args(); render(a.lots, a.output, a.yaml_module)
