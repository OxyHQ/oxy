#!/usr/bin/env python3
"""Deliver dedicated activity secrets to existing Cloudflare deployments only.

No secret reaches argv, stdout, logs, artifacts, or browser build variables.
The closed registry binds an existing Oxy application to its own destinations.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.error
import urllib.request

REGISTRY = Path(__file__).resolve().parents[1] / 'config/edge-activity-targets.json'


def targets(app_id):
    entry = json.loads(REGISTRY.read_text()).get(app_id)
    if not entry:
        raise ValueError('Application is not registered for edge activity')
    return entry


def api(method, path, payload=None):
    account = os.environ['CLOUDFLARE_ACCOUNT_ID']
    request = urllib.request.Request(
        f'https://api.cloudflare.com/client/v4/accounts/{account}/{path}',
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN'],
                 'Content-Type': 'application/json'}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        # Response bodies may echo submitted secrets. Never log them.
        if error.code == 404 and method == 'GET':
            return None
        raise RuntimeError(f'Cloudflare {method} failed (HTTP {error.code})') from None
    if not result.get('success'):
        raise RuntimeError(f'Cloudflare {method} failed')
    return result.get('result')


def deployed(kind, name):
    if kind == 'pages':
        project = api('GET', f'pages/projects/{name}')
        deployment = (project or {}).get('canonical_deployment')
        return bool(deployment and deployment.get('environment') == 'production'
                    and deployment.get('latest_stage', {}).get('status') == 'success')
    deployment = api('GET', f'workers/scripts/{name}/deployments')
    return bool(deployment and deployment.get('deployments'))


def secret(namespace, name):
    result = subprocess.run(
        ['aws', 'ssm', 'get-parameter', '--name', f'/oxy/{namespace}/{name}',
         '--with-decryption', '--output', 'json'], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('Required activity credential is unavailable')
    parameter = json.loads(result.stdout)['Parameter']
    if parameter.get('Type') != 'SecureString' or not parameter.get('Value'):
        raise RuntimeError('Activity credential must be a nonempty SecureString')
    return parameter['Value']


def deliver(app_id, dry_run=True, enabled=False):
    entry = targets(app_id)
    live = []
    for kind, name in entry['targets']:
        exists = deployed(kind, name)
        print(f'{kind}/{name}: {"deployed" if exists else "inactive or absent"}')
        if exists:
            live.append((kind, name))
    if not live:
        raise RuntimeError('No existing deployed target; refusing credential delivery')
    if dry_run:
        return
    values = {name: secret(entry['namespace'], name) for name in
              ('OXY_EDGE_ACTIVITY_API_KEY', 'OXY_EDGE_ACTIVITY_API_SECRET')}
    values['OXY_EDGE_ACTIVITY_ENABLED'] = 'true' if enabled else 'false'
    for kind, name in live:
        if kind == 'workers':
            api('PATCH', f'workers/scripts/{name}/secrets-bulk', {
                'secrets': {key: {'name': key, 'type': 'secret_text', 'text': value}
                            for key, value in values.items()}})
        else:
            api('PATCH', f'pages/projects/{name}', {'deployment_configs': {
                'production': {'env_vars': {key: {'type': 'secret_text', 'value': value}
                                           for key, value in values.items()}}}})
        print(f'{kind}/{name}: dedicated activity bindings stored; enabled={enabled}')


if __name__ == '__main__':
    try:
        deliver(os.environ['APP_ID'], os.environ.get('DRY_RUN', 'true') != 'false',
                os.environ.get('EDGE_ACTIVITY_ENABLED', 'false') == 'true')
    except Exception as error:
        # Only our fixed messages are safe; unknown exceptions can include bodies.
        message = str(error) if isinstance(error, (RuntimeError, ValueError)) else type(error).__name__
        print(f'::error::{message}', file=sys.stderr)
        sys.exit(1)
