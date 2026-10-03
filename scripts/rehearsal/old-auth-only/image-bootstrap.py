"""Own Docker containers for an exact config ID; no registry or rebuild path."""
import json
import os
from pathlib import Path
import re
import secrets
import subprocess


def validate_image(image):
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
        raise ValueError('An immutable Docker config ID is required')
    return image


def container_command(image, source, owned, name, cidfile, script, args, runtime):
    validate_image(image)
    if script not in ('host.mjs', 'probe.mjs'):
        raise ValueError('Only the reviewed bootstrap and probe are supported')
    command = ['docker', 'run', '--name', name, '--cidfile', str(cidfile),
               '--label', 'oxy.auth-only.proof=' + name, '--network', 'host',
               '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
               '--pids-limit', '256', '--memory', '1g', '--user', f'{os.getuid()}:{os.getgid()}',
               '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m', '--workdir', '/app',
               '--mount', f'type=bind,src={source / "scripts/rehearsal/old-auth-only"},dst=/proof/old-auth-only,readonly',
               '--mount', f'type=bind,src={owned},dst=/proof/output', '--entrypoint', 'node']
    # Values stay in the subprocess environment, never in the command/log arguments.
    for key in sorted(runtime):
        command += ['--env', key]
    return command + [image, '/proof/old-auth-only/' + script, *args]


class ImageBootstrap:
    def __init__(self, image, source, owned, command):
        self.image = validate_image(image)
        self.source, self.owned, self.command = source, owned, command
        self.containers = []
        inspected = self.inspect(image)
        assert inspected['Id'] == image and inspected['Architecture'] == 'arm64' and inspected['Os'] == 'linux'
        self.inspection = inspected

    def inspect(self, target):
        return json.loads(self.command(['docker', 'inspect', target]))[0]

    def run(self, script, args, runtime):
        name = 'oxy-auth-only-' + secrets.token_hex(12)
        cid = self.owned / (name + '.cid')
        row = {'name': name, 'cidfile': cid, 'id': None, 'script': script}
        # Register BEFORE dispatch: even a lost CLI response can be reconciled by own name.
        self.containers.append(row)
        return container_command(self.image, self.source, self.owned, name, cid, script, args, runtime)

    def verify(self, row, running=False):
        observed = self.inspect(row['name'])
        assert observed['Image'] == self.image
        assert observed['Name'] == '/' + row['name']
        assert observed['Config']['Labels']['oxy.auth-only.proof'] == row['name']
        assert observed['Config']['Entrypoint'] == ['node']
        assert observed['Config']['Cmd'][0] == '/proof/old-auth-only/' + row['script']
        assert re.fullmatch(r'[0-9a-f]{64}', observed['Id'])
        assert row['cidfile'].read_text().strip() == observed['Id']
        assert observed['HostConfig']['ReadonlyRootfs'] is True
        assert observed['HostConfig']['NetworkMode'] == 'host'
        assert observed['HostConfig']['CapDrop'] == ['ALL']
        assert 'no-new-privileges:true' in observed['HostConfig']['SecurityOpt']
        if running:
            assert observed['State']['Running'] and observed['State']['Pid'] > 0
        row['id'] = observed['Id']
        return {'id': observed['Id'], 'image': observed['Image'], 'script': row['script'],
                'running': observed['State']['Running'], 'exitCode': observed['State']['ExitCode']}

    def stop(self):
        outcomes = []
        for row in reversed(self.containers):
            try:
                observed = self.inspect(row['name'])
            except subprocess.CalledProcessError:
                # Absence must be read back by an exact-name census, not inferred from a failed inspect.
                census = self.command(['docker', 'ps', '-a', '--filter', 'name=^/' + row['name'] + '$', '--format', '{{.ID}}']).strip()
                assert not census, 'Own container state is unresolved; DB must stay intact'
                outcomes.append({'name': row['name'], 'absent': True})
                continue
            assert observed['Image'] == self.image and observed['Config']['Labels']['oxy.auth-only.proof'] == row['name']
            target = observed['Id']
            if observed['State']['Running']:
                self.command(['docker', 'stop', '--time', '15', target], timeout=30)
            stopped = self.inspect(target)
            assert not stopped['State']['Running']
            self.command(['docker', 'rm', target])
            assert not self.command(['docker', 'ps', '-a', '--filter', 'id=' + target, '--format', '{{.ID}}']).strip()
            outcomes.append({'id': target, 'image': self.image, 'absent': True})
        return outcomes
