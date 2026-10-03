#!/usr/bin/env python3
"""Own a fresh loopback Redis process; reject inherited connection URLs."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
PORT = 6389
REDIS = Path(shutil.which('redis-server'))
scratch = Path(tempfile.mkdtemp(prefix='oxy1519-capacity-'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG') and not k.startswith('REDIS')
       and k not in ('DATABASE_URL', 'TEST_DATABASE_URL', 'OXY_CAPACITY_OWNED_REDIS_PID')}
server = subprocess.Popen([str(REDIS), '--bind', '127.0.0.1', '--port', str(PORT),
                           '--save', '', '--appendonly', 'no', '--dir', str(scratch)],
                          stdout=(scratch / 'redis.log').open('w'), stderr=subprocess.STDOUT, env=env)
try:
    for _ in range(100):
        if server.poll() is not None:
            raise RuntimeError('Owned Redis failed to start (possible occupied port)')
        try:
            reply = subprocess.check_output(['redis-cli', '-h', '127.0.0.1', '-p', str(PORT), 'PING'], env=env, timeout=1)
            if reply.strip() == b'PONG':
                break
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            pass
        time.sleep(.05)
    assert Path(f'/proc/{server.pid}').stat().st_uid == os.getuid()
    assert Path(f'/proc/{server.pid}/exe').resolve() == REDIS.resolve()
    info = subprocess.check_output(['redis-cli', '-h', '127.0.0.1', '-p', str(PORT), 'INFO', 'server'], env=env, timeout=3)
    assert f'process_id:{server.pid}\r\n'.encode() in info
    sockets = {os.readlink(fd) for fd in Path(f'/proc/{server.pid}/fd').iterdir()}
    rows = [row.split() for row in Path('/proc/net/tcp').read_text().splitlines()[1:]]
    matches = [row for row in rows if row[1] == f'0100007F:{PORT:04X}' and row[3] == '0A']
    assert len(matches) == 1 and f'socket:[{matches[0][9]}]' in sockets
    print(json.dumps({'ownedRedisPid': server.pid, 'executable': str(REDIS), 'scratch': str(scratch), 'port': PORT}), flush=True)
    result = subprocess.run(['bun', 'scripts/rehearsal/test-service-token-capacity-1519.ts'], cwd=ROOT,
                            env=env | {'NODE_ENV': 'test', 'REDIS_URL': f'redis://127.0.0.1:{PORT}/0',
                                       'OXY_CAPACITY_OWNED_REDIS_PID': str(server.pid)}, check=False)
    result.check_returncode()
finally:
    server.terminate()
    server.wait(timeout=15)
    print(json.dumps({'ownedRedisStopped': server.poll() is not None, 'exitCode': server.returncode}), flush=True)
