#!/usr/bin/env python3
"""Bounded SQL state readback of the owned WEB04 fixture, excluding credentials."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
PG = Path('/usr/lib/postgresql/17/bin')


def main():
    assert len(sys.argv) == 3, 'Owned manifest and observation label required'
    manifest_path = Path(sys.argv[1]).resolve()
    assert manifest_path.parent.parent == ROOT / '.integration-evidence'
    assert manifest_path.parent.name.startswith('oauth1519-') and manifest_path.name == 'manifest.json'
    label = sys.argv[2]
    assert re.fullmatch(r'[a-z0-9-]{1,48}', label)
    manifest = json.loads(manifest_path.read_text())
    assert manifest['fixtureOnly'] is True
    data = manifest_path.parent / 'data'
    pid_rows = (data / 'postmaster.pid').read_text().splitlines()
    pid = int(pid_rows[0])
    assert Path(pid_rows[1]).resolve() == data and pid_rows[3] == '5589'
    process = Path(f'/proc/{pid}')
    assert process.stat().st_uid == os.getuid()
    assert (process / 'exe').resolve() == PG / 'postgres'
    arguments = (process / 'cmdline').read_bytes().split(b'\0')
    assert b'-D' in arguments and str(data).encode() in arguments
    sockets = {os.readlink(fd) for fd in (process / 'fd').iterdir()}
    listeners = [line.split() for line in Path('/proc/net/tcp').read_text().splitlines()[1:]]
    matches = [line for line in listeners if line[1] == '0100007F:15D5' and line[3] == '0A']
    assert len(matches) == 1 and f'socket:[{matches[0][9]}]' in sockets
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LANG': 'C.UTF-8'}
    psql = [str(PG / 'psql'), '-X', '-h', '127.0.0.1', '-p', '5589',
            '-U', 'oxy', '-v', 'ON_ERROR_STOP=1', '-qAt']
    discovery = subprocess.run(psql + ['-d', 'postgres'],
                              input="BEGIN READ ONLY; SELECT datname FROM pg_database "
                                    "WHERE datname ~ '^oxy_browser_1519_[a-f0-9]{16}$'; ROLLBACK;",
                              env=env, text=True, capture_output=True, timeout=15)
    assert discovery.returncode == 0, discovery.stderr
    names = discovery.stdout.splitlines()
    assert len(names) == 1 and re.fullmatch(r'oxy_browser_1519_[a-f0-9]{16}', names[0])
    database = names[0]
    person, organization = manifest['person']['id'], manifest['organization']['id']
    app_ids = [manifest['clients'][lane]['appId'] for lane in ('webFirst', 'webSecond')]
    for value in [person, organization, *app_ids]:
        assert re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value)
    accounts = ','.join(f"'{value}'" for value in [person, organization])
    apps = ','.join(f"'{value}'" for value in app_ids)
    # Shared official sessions intentionally have application_id/client_id NULL;
    # filter by fixture subjects and desktop lane, retaining prior desktop rows
    # for before/after comparison rather than pretending every row is new WEB04.
    query = f"""
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '10000';
SET LOCAL lock_timeout = '2000';
SET LOCAL idle_in_transaction_session_timeout = '15000';
SELECT jsonb_build_object('kind','snapshot','readOnly',current_setting('transaction_read_only'),
 'isolation',current_setting('transaction_isolation'),'dataDirectory',current_setting('data_directory'),
 'observedAt',transaction_timestamp());
SELECT jsonb_build_object('kind','applications','rows',coalesce(jsonb_agg(r), '[]'::jsonb)) FROM
 (SELECT id,type,is_official,is_internal,status,scopes FROM applications WHERE id IN ({apps}) ORDER BY id) r;
SELECT jsonb_build_object('kind','sessions','rows',coalesce(jsonb_agg(r), '[]'::jsonb)) FROM
 (SELECT encode(sha256(convert_to(session_id,'UTF8')),'hex') AS session_id_digest,
 user_id,operated_by_user_id,application_id,client_id,scopes,device_session_id,device_context_id,
 is_active,expires_at > transaction_timestamp() AS unexpired,device_type,platform,
 encode(sha256(convert_to(device_id,'UTF8')),'hex') AS device_id_digest
 FROM sessions WHERE user_id IN ({accounts}) AND device_type='desktop' ORDER BY session_id) r;
WITH selected AS (SELECT DISTINCT device_session_id AS id FROM sessions
 WHERE user_id IN ({accounts}) AND device_type='desktop' AND device_session_id IS NOT NULL)
SELECT jsonb_build_object('kind','devices','rows',coalesce(jsonb_agg(r), '[]'::jsonb)) FROM
 (SELECT d.id,encode(sha256(convert_to(d.device_id,'UTF8')),'hex') AS device_id_digest,
 d.active_account_id,d.active_context_id,d.revision,
 (SELECT count(*) FROM device_credentials c WHERE c.device_session_id=d.id) AS holder_count
 FROM device_sessions d JOIN selected ON selected.id=d.id ORDER BY d.id) r;
WITH selected AS (SELECT DISTINCT device_session_id AS id FROM sessions
 WHERE user_id IN ({accounts}) AND device_type='desktop' AND device_session_id IS NOT NULL)
SELECT jsonb_build_object('kind','contexts','rows',coalesce(jsonb_agg(r), '[]'::jsonb)) FROM
 (SELECT c.id,c.device_session_id,c.principal_id,c.account_id,c.revoked_at,
 encode(sha256(convert_to(c.session_id,'UTF8')),'hex') AS session_id_digest,p.user_id AS principal_user_id,
 p.revoked_at AS principal_revoked_at
 FROM device_account_contexts c JOIN selected ON selected.id=c.device_session_id
 JOIN device_principals p ON p.id=c.principal_id ORDER BY c.id) r;
ROLLBACK;
"""
    result = subprocess.run(psql + ['-d', database],
                            input=query, env=env, text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert len(result.stdout.encode()) <= 262144
    rows = [json.loads(line) for line in result.stdout.splitlines()]
    assert len(rows) == 5 and rows[0]['readOnly'] == 'on'
    assert rows[0]['isolation'] == 'repeatable read' and rows[0]['dataDirectory'] == str(data)
    assert all(len(row['rows']) <= 1000 for row in rows[1:])
    output = manifest_path.parent / f'web04-state-{label}.jsonl'
    with output.open('x') as stream:
        os.chmod(output, 0o600)
        stream.write(result.stdout)
    print(json.dumps({'readOnly': True, 'output': str(output),
                      'sha256': hashlib.sha256(result.stdout.encode()).hexdigest(),
                      'counts': {row['kind']: len(row['rows']) for row in rows[1:]}}))


if __name__ == '__main__':
    main()
