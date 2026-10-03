#!/usr/bin/env python3
"""Offline black-box checks of the local receiver launcher, with real owned PG.

Only migrations and the event receiver are fixture Bun bodies. The launcher,
process groups, environment scrub, PG ownership validation and finally are real.
No provider key, request or object is used.
"""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
BUN = shutil.which('bun')


class ReceiverIsolation(unittest.TestCase):
    def exercise(self, signum=None, group=False):
        with tempfile.TemporaryDirectory(prefix='oxy-zero-launcher-') as directory:
            fixture = Path(directory)
            scripts = fixture / 'scripts/billing'
            scripts.mkdir(parents=True)
            api = fixture / 'packages/api'
            api.mkdir(parents=True)
            for filename in ('test-stripe-zero-receiver.py', 'stripe-oxy-sandbox.py'):
                shutil.copyfile(ROOT / 'scripts/billing' / filename, scripts / filename)
            # Inert values which must not reappear after either scrub or dotenv.
            dotenv = 'AWS_ACCESS_KEY_ID=fixture_dotenv\nGH_TOKEN=fixture_dotenv\nOXY_DOTENV_SENTINEL=fixture_dotenv\n'
            (fixture / '.env').write_text(dotenv)
            (api / '.env').write_text(dotenv)
            child = fixture / 'child.mjs'
            child.write_text('''import fs from 'node:fs';
const dir = process.env.TMPDIR;
const observed = { bunOptions: process.env.BUN_OPTIONS,
  aws: process.env.AWS_ACCESS_KEY_ID ?? null,
  gh: process.env.GH_TOKEN ?? null,
  dotenv: process.env.OXY_DOTENV_SENTINEL ?? null };
if (process.argv[2] === 'migration') {
  fs.appendFileSync(`${dir}/migration.jsonl`, JSON.stringify(observed)+'\\n');
  process.exit(0);
}
fs.writeFileSync(`${dir}/ready.json`, JSON.stringify({...observed,pid:process.pid}));
if (fs.existsSync(`${dir}/normal`)) process.exit(0);
for (const name of ['SIGTERM','SIGINT']) process.on(name, () => {
  const pg = Number(fs.readFileSync(`${dir}/owned-pg-pid`, 'utf8'));
  fs.writeFileSync(`${dir}/cleanup.json`, JSON.stringify({signal:name,
    postgresStillAlive:fs.existsSync(`/proc/${pg}`)}));
  process.exit(name==='SIGTERM'?143:130);
});
setInterval(()=>{},100);
''')
            binaries = fixture / 'bin'
            binaries.mkdir()
            # Exec the real Bun process: a group signal reaches the actual child.
            # db:migrate is replaced only because the offline fixture has no schema.
            shim = binaries / 'bun'
            shim.write_text('#!/usr/bin/python3\nimport os,sys\n'
                + "assert sys.argv[1] == '--no-env-file'\n"
                + "assert os.environ['BUN_OPTIONS'] == '--no-env-file'\n"
                + f"args=[{BUN!r},'--no-env-file',{str(child)!r},'migration' if 'db:migrate' in sys.argv else 'receiver']\n"
                + f"os.execv({BUN!r},args)\n")
            shim.chmod(0o700)
            if signum is None:
                (fixture / 'normal').touch()
            env = os.environ | {'PATH': f'{binaries}:{os.environ["PATH"]}',
                'TMPDIR': str(fixture), 'AWS_ACCESS_KEY_ID':'inherited_fixture',
                'GH_TOKEN':'inherited_fixture', 'BUN_OPTIONS':'--env-file=forbidden'}
            process = subprocess.Popen(['python3','-B',str(scripts/'test-stripe-zero-receiver.py'),
                str(fixture/'event-fixture')], cwd=fixture, env=env,
                start_new_session=True, stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
            pg_pid = None
            try:
                deadline = time.monotonic()+30
                while not (fixture/'ready.json').exists():
                    if process.poll() is not None:
                        self.fail(process.communicate()[0])
                    self.assertLess(time.monotonic(),deadline,'Child readiness not observed')
                    time.sleep(0.05)
                postmaster = next((fixture/'.billing-evidence').glob('*/data/postmaster.pid'))
                pg_pid = int(postmaster.read_text().splitlines()[0])
                (fixture/'owned-pg-pid').write_text(str(pg_pid))
                if signum is not None:
                    if group:
                        os.killpg(process.pid,signum)
                    else:
                        os.kill(process.pid,signum)
                output = process.communicate(timeout=40)[0]
                rows = [json.loads(line) for line in output.splitlines() if line.startswith('{')]
                stop = next(row for row in rows if row.get('phase') == 'beforeOwnedPgStop')
                self.assertTrue(stop['childStopped'])
                self.assertFalse(stop['forced'])
                self.assertEqual(stop['requestedSignal'],signum)
                self.assertFalse(Path(f'/proc/{pg_pid}').exists())
                ready = json.loads((fixture/'ready.json').read_text())
                self.assertFalse(Path(f'/proc/{ready["pid"]}').exists())
                for observed in [ready]+[json.loads(line) for line in (fixture/'migration.jsonl').read_text().splitlines()]:
                    self.assertEqual(observed['bunOptions'],'--no-env-file')
                    self.assertIsNone(observed['aws'])
                    self.assertIsNone(observed['gh'])
                    self.assertIsNone(observed['dotenv'])
                self.assertEqual(len((fixture/'migration.jsonl').read_text().splitlines()),3)
                if signum is None:
                    self.assertEqual(process.returncode,0,output)
                else:
                    self.assertNotEqual(process.returncode,0)
                    cleanup = json.loads((fixture/'cleanup.json').read_text())
                    self.assertTrue(cleanup['postgresStillAlive'])
                    self.assertEqual(cleanup['signal'],signal.Signals(signum).name)
                print(json.dumps({'case':signal.Signals(signum).name if signum else 'normal',
                    'groupSignal':group,'ownedPgPid':pg_pid,'pgStopped':True,
                    'childBeforePgStop':True,'dotenvAndInheritedCredentialsAbsent':True}))
            finally:
                if process.poll() is None:
                    os.killpg(process.pid,signal.SIGTERM)
                    process.communicate(timeout=40)

    def test_normal_and_dotenv_descendants(self):
        self.exercise()

    def test_sigterm_parent(self):
        self.exercise(signal.SIGTERM)

    def test_sigint_parent_group(self):
        self.exercise(signal.SIGINT,group=True)


if __name__ == '__main__':
    unittest.main()
