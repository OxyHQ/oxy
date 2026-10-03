#!/usr/bin/env python3
"""Fixed namespace/executable/shape negatives only; no AWS or credential values."""
import copy
import hashlib
import importlib.util
from pathlib import Path

path = Path(__file__).with_name('run-service-token-issuer-canary-1519.py')
spec = importlib.util.spec_from_file_location('canary', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
refs = [{'name': 'OXY_CANARY_API_KEY', 'valueFrom': 'arn:aws:ssm:us-west-2:237343248947:parameter/oxy/noted/OXY_APPLICATION_KEY'},
        {'name': 'OXY_CANARY_API_SECRET', 'valueFrom': 'arn:aws:ssm:us-west-2:237343248947:parameter/oxy/noted/OXY_APPLICATION_SECRET'}]
plan = {'profile': 'noted', 'nonce': 'a'*32, 'readerSha256': hashlib.sha256(module.READER.read_bytes()).hexdigest(),
        'live': {'executionRoleArn': 'arn:aws:iam::237343248947:role/fixture-execution-role', 'cpu': '512', 'memory': '1024',
                 'runtimePlatform': {'cpuArchitecture': 'ARM64', 'operatingSystemFamily': 'LINUX'}, 'image': 'fixture@sha256:'+'b'*64,
                 'canarySecrets': refs, 'logGroup': '/oxy/ecs', 'logStreamPrefix': 'noted'}}
definition = module.build_definition(plan)
assert not definition.get('taskRoleArn') and definition['containerDefinitions'][0]['environment'] == []
assert definition['containerDefinitions'][0]['secrets'] == refs
assert not any(row['name'] == 'DATABASE_URL' for row in definition['containerDefinitions'][0]['secrets'])
assert 'probeIssuer' in definition['containerDefinitions'][0]['command'][-1]
registered = copy.deepcopy(definition)
registered.update(taskDefinitionArn='arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-issuer-mint-canary-noted:1', status='ACTIVE')
module.verify_registered(registered, definition)
for mutation in ['taskRoleArn', 'secret', 'command', 'image', 'mount']:
    wrong = copy.deepcopy(registered)
    if mutation == 'taskRoleArn': wrong['taskRoleArn'] = 'unexpected-role'
    if mutation == 'secret': wrong['containerDefinitions'][0]['secrets'].append({'name': 'DATABASE_URL', 'valueFrom': 'unexpected'})
    if mutation == 'command': wrong['containerDefinitions'][0]['command'] = ['unexpected']
    if mutation == 'image': wrong['containerDefinitions'][0]['image'] = 'mutable:latest'
    if mutation == 'mount': wrong['containerDefinitions'][0]['mountPoints'] = [{'sourceVolume': 'unexpected'}]
    try:
        module.verify_registered(wrong, definition)
        raise AssertionError('Mutation accepted: '+mutation)
    except RuntimeError:
        pass
try:
    module.build_definition({**plan, 'readerSha256': '0'*64})
    raise AssertionError('Changed probe accepted')
except RuntimeError:
    pass
print('Canary launcher exact shape/secret namespace: positive + six mutation negatives PASS; no AWS executed.')
