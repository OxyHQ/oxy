#!/usr/bin/env python3
"""Combined machine/private package tests using only a freshly initialized, verified local PG process."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path('/home/nate/Oxy/oxy/.worktrees/1572-jev-exact-activation-20261004')
PG = Path('/usr/lib/postgresql/17/bin')
PORT = 5627


def main():
    if len(os.sys.argv) != 1:
        raise SystemExit('Runtime/connection overrides are not accepted')
    env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR')}
    env['BUN_OPTIONS'] = '--no-env-file'
    own = Path(tempfile.mkdtemp(prefix='mention-wire-pg-', dir='/home/nate/Oxy/.agent-evidence'))
    data = own / 'data'
    def run(argv, **kw):
        return subprocess.run([str(x) for x in argv], env=env, text=True, check=True, **kw)
    started = int(time.time())
    run([PG / 'initdb', '-D', data, '-U', 'oxy', '-A', 'trust', '--no-locale'], stdout=subprocess.DEVNULL)
    run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',own/'server.key','-out',own/'server.crt'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    (own/'server.key').chmod(0o600)
    active = False
    pid = None
    try:
        run([PG / 'pg_ctl', '-D', data, '-l', own / 'server.log', '-w', '-o', f'-h 127.0.0.1 -p {PORT} -k {own} -c ssl=on -c ssl_cert_file={own}/server.crt -c ssl_key_file={own}/server.key', 'start'])
        active = True
        state = (data / 'postmaster.pid').read_text().splitlines()
        pid = int(state[0])
        assert Path(state[1]).resolve() == data.resolve() and int(state[2]) >= started and int(state[3]) == PORT
        assert Path(f'/proc/{pid}').stat().st_uid == os.getuid()
        assert Path(f'/proc/{pid}/exe').resolve() == (PG / 'postgres').resolve()
        args = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
        assert b'-D' in args and str(data).encode() in args
        sockets = {os.readlink(fd) for fd in Path(f'/proc/{pid}/fd').iterdir()}
        rows = [r.split() for r in Path('/proc/net/tcp').read_text().splitlines()[1:]]
        matches = [r for r in rows if r[1] == f'0100007F:{PORT:04X}' and r[3] == '0A']
        assert len(matches) == 1 and f'socket:[{matches[0][9]}]' in sockets
        # Descendants of package scripts also disable Bun dotenv auto-loading.
        real_bun = subprocess.check_output(['which', 'bun'], env=env, text=True).strip()
        wrappers = own / 'bin'
        wrappers.mkdir()
        wrapper = wrappers / 'bun'
        wrapper.write_text('#!/bin/sh\nexec ' + real_bun + ' --no-env-file "$@"\n')
        wrapper.chmod(0o700)
        env |= {'PATH': str(wrappers) + ':' + env['PATH'], 'TEST_DATABASE_URL': f'postgresql://oxy@127.0.0.1:{PORT}/postgres', 'DATABASE_URL': f'postgresql://oxy@127.0.0.1:{PORT}/postgres', 'NODE_ENV': 'test'}
        print(json.dumps({'verifiedOwnPostgresPid': pid, 'dataDirectory': str(data), 'port': PORT, 'liveAccess': False}), flush=True)
        run([PG / 'psql', '-h','127.0.0.1','-p',str(PORT),'-U','oxy','-d','postgres','-v','ON_ERROR_STOP=1','-c','CREATE ROLE kaana_runtime NOLOGIN; CREATE ROLE kaana_migrator NOLOGIN; CREATE ROLE kaana_credential_admin NOLOGIN; CREATE ROLE kaana_customer_credential_control NOLOGIN; CREATE ROLE kaana_platform_credential_control NOLOGIN;'])
        run([PG / 'createdb', '-h', '127.0.0.1', '-p', str(PORT), '-U', 'oxy', 'kaana_wire'])
        import hashlib, tarfile
        candidate=Path('/home/nate/Oxy/.agent-evidence/root-1519-full-completion-20261004/core44-publication/core.tgz')
        assert hashlib.sha256(candidate.read_bytes()).hexdigest() == '49d95b3d5009981ce518f1fd0ae34b62da905d91edad12df7607d10b6b36aa4b'
        sdk=ROOT / 'packages/api/node_modules/.cache/mention-wire-core44'
        sdk.mkdir(parents=True,exist_ok=True)
        with tarfile.open(candidate) as archive:
            files=archive.getmembers()
            assert len(files)==585 and len({m.name for m in files})==585 and all(m.isfile() and m.name.startswith('package/') and '..' not in Path(m.name).parts for m in files)
            archive.extractall(sdk,filter='data')
        env |= {'KAANA_WIRE_DATABASE_URL':f'postgresql://oxy@127.0.0.1:{PORT}/kaana_wire?sslmode=verify-full&sslrootcert={own}/server.crt', 'MENTION_SOURCE_WORKTREE':'/home/nate/Oxy/Mention/.worktrees/1572-bounded-shadow-20261004', 'KAANA_SOURCE_WORKTREE':'/home/nate/Oxy/Kaana/.worktrees/1572-jev-exact-activation-20261004','MENTION_BUILDER_SHA256':'060543df2f3ddb756a274c2680d73d02da4fbc5b949c41c258345916e6eb301d','MENTION_WIRE_SDK_MODULE':str(sdk / 'package/dist/cjs/inference/index.js')}
        run(['bun', 'run', 'test', '--runInBand', '--runTestsByPath', 'src/routes/__fixtures__/mentionWire.fixture.ts', '--testMatch', '**/mentionWire.fixture.ts'], cwd=ROOT / 'packages/api',timeout=170)
    finally:
        if active:
            run([PG / 'pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop'])
            assert pid is not None and not Path(f'/proc/{pid}').exists()
        print(json.dumps({'ownedPostgresStopped': active, 'pidAbsent': pid is None or not Path(f'/proc/{pid}').exists(), 'record': str(own)}), flush=True)


if __name__ == '__main__':
    main()
