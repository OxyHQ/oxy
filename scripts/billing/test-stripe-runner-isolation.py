"""Actual runner process coordination with isolated dotenv and fake cleanup; no Stripe/DB."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest

SOURCE = Path(__file__).with_name('stripe-oxy-sandbox.py').resolve()
SPEC = importlib.util.spec_from_file_location('stripe_runner', SOURCE)
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


def wait_file(path, process, seconds=10):
    deadline = time.monotonic() + seconds
    while not path.exists():
        if process.poll() is not None or time.monotonic() >= deadline:
            raise AssertionError('Fixture did not reach the observable barrier')
        time.sleep(.01)


class RunnerIsolationTests(unittest.TestCase):
    def test_bun_options_disables_dotenv_in_actual_builder_and_nested_processes(self):
        with tempfile.TemporaryDirectory(prefix='oxy-bun-env-') as folder:
            root = Path(folder)
            (root/'package.json').write_text(json.dumps({'name':'fixture','workspaces':['packages/*']}))
            probe = "console.log(JSON.stringify({phase:process.argv[2],sentinelPresent:['STRIPE_SECRET_KEY','DATABASE_URL','OXY_DOTENV_SENTINEL'].some(k=>process.env[k]!==undefined),explicitNamespace:process.env.BILLING_PROCESSOR_ENVIRONMENT}));"
            (root/'probe.mjs').write_text(probe)
            sentinel = 'STRIPE_SECRET_KEY=offline_sentinel\nDATABASE_URL=offline_sentinel\nOXY_DOTENV_SENTINEL=offline_sentinel\n'
            for name in ('.env','.env.test','.env.local','.env.test.local'):
                (root/name).write_text(sentinel)
            for name in ('one','two'):
                package = root/'packages'/name; package.mkdir(parents=True)
                for dotenv in ('.env','.env.test','.env.local','.env.test.local'):
                    (package/dotenv).write_text(sentinel)
                (package/'package.json').write_text(json.dumps({'name':'@fixture/'+name,'scripts':{'build':f'bun ../../probe.mjs build-{name} && bun run nested','nested':f'bun ../../probe.mjs nested-{name}'}}))
            env = RUNNER.scrub() | {'NODE_ENV':'test','BILLING_PROCESSOR_ENVIRONMENT':'test'}
            baseline = env.copy(); baseline.pop('BUN_OPTIONS')
            red = subprocess.check_output(['bun','probe.mjs','baseline'],cwd=root,env=baseline,text=True)
            self.assertTrue(json.loads(red)['sentinelPresent'])
            # These are the actual bootstrap, migration and child Bun command forms.
            for label, args in [('bootstrap',['bun','--no-env-file','-e',probe.replace('process.argv[2]',json.dumps('bootstrap'))]),('migration',['bun','--no-env-file','run','probe.mjs','migration']),('child',['bun','--no-env-file','run','probe.mjs','child'])]:
                observed=json.loads(subprocess.check_output(args,cwd=root,env=env,text=True))
                self.assertFalse(observed['sentinelPresent'],label)
                self.assertEqual(observed['explicitNamespace'],'test')
            # Actual shared builder launches Bun; package scripts launch further Bun.
            result=subprocess.check_output(['node',str(RUNNER.ROOT/'packages/core/scripts/build-workspace-deps.mjs'),'@fixture/one','@fixture/two'],cwd=root,env=env,text=True,stderr=subprocess.STDOUT)
            observations=[]
            for row in result.splitlines():
                start=row.find('{')
                if start>=0:
                    try: observations.append(json.loads(row[start:]))
                    except json.JSONDecodeError: pass
            self.assertEqual({x['phase'] for x in observations},{'build-one','nested-one','build-two','nested-two'})
            self.assertTrue(all(not x['sentinelPresent'] and x['explicitNamespace']=='test' for x in observations))

    def test_owned_postgres_lives_outside_launcher_signal_group(self):
        scratch=RUNNER.ROOT/'.billing-evidence';scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='runner-signal-pg-',dir=scratch) as folder, tempfile.TemporaryDirectory(prefix='oxy-runner-signal-') as socket_folder:
            root=Path(folder);data=root/'data';socket=Path(socket_folder)
            env=RUNNER.scrub();started=False;pid=None
            try:
                subprocess.check_output([str(RUNNER.PG/'initdb'),'-D',str(data),'-U','oxy','-A','trust','--no-locale'],env=env,stderr=subprocess.STDOUT)
                subprocess.check_output([str(RUNNER.PG/'pg_ctl'),'-D',str(data),'-l',str(root/'server.log'),'-w','-o',f'-h 127.0.0.1 -p 5596 -k {socket}','start'],env=env,stderr=subprocess.STDOUT)
                started=True
                rows=(data/'postmaster.pid').read_text().splitlines();pid=int(rows[0])
                self.assertEqual(Path(rows[1]).resolve(),data.resolve())
                self.assertEqual(Path(f'/proc/{pid}/exe').resolve(),(RUNNER.PG/'postgres').resolve())
                self.assertEqual(Path(f'/proc/{pid}').stat().st_uid,os.getuid())
                self.assertNotEqual(os.getpgid(pid),os.getpgrp())
                self.assertEqual(int(rows[3]),5596)
            finally:
                if started:
                    subprocess.check_output([str(RUNNER.PG/'pg_ctl'),'-D',str(data),'-m','fast','-w','stop'],env=env,stderr=subprocess.STDOUT)
                    self.assertFalse(Path(f'/proc/{pid}').exists())

    def run_signal(self, signum, to_group, forced=False):
        with tempfile.TemporaryDirectory(prefix='oxy-runner-signal-') as folder:
            root=Path(folder)
            child=root/'child.py'
            child.write_text('''import json,os,signal,sys,time
from pathlib import Path
root=Path(sys.argv[1]);forced=sys.argv[2]=='forced'
def write(name,value): (root/name).write_text(json.dumps(value))
def signal_received(number,_frame):
 write('received.json',{'signal':number})
 if forced: return
 write('cleanup-started.json',{'pendingOwnObject':True})
 while not (root/'release').exists(): time.sleep(.01)
 write('cleanup-finished.json',{'unresolvedObjects':0})
 sys.exit(0)
signal.signal(signal.SIGINT,signal_received);signal.signal(signal.SIGTERM,signal_received)
write('pending.json',{'pid':os.getpid(),'requestPending':True})
while True: time.sleep(.02)
''')
            driver=root/'driver.py'
            driver.write_text('''import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('runner',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(sys.argv[2]);forced=sys.argv[3]=='forced'
original_coordinator=m.SignalCoordinator
m.SignalCoordinator=lambda: original_coordinator(cleanup_timeout_seconds=.2 if forced else 5)
def fake_owned_provider_and_pg(path,c):
 result=c.run([sys.executable,str(root/'child.py'),str(root),'forced' if forced else 'normal'])
 # This represents the execute_owned finally boundary, after child completion.
 (root/'pg-stopped.json').write_text(json.dumps({'childFinishedBeforePgStop':(root/'cleanup-finished.json').exists(),'forced':c.forced,'signal':c.requested_signal,'exitCode':result.returncode,'cleanupRequiresManifestReview':c.forced,'childStopped':c.last_child_stopped}))
m.execute_owned=fake_owned_provider_and_pg
m.execute(root/'plan.json')
''')
            parent=subprocess.Popen(['python3',str(driver),str(SOURCE),str(root),'forced' if forced else 'normal'],start_new_session=True,env=RUNNER.scrub(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            try:
                wait_file(root/'pending.json',parent)
                child_pid=json.loads((root/'pending.json').read_text())['pid']
                if to_group: os.killpg(parent.pid,signum)
                else: os.kill(parent.pid,signum)
                wait_file(root/'received.json',parent)
                self.assertEqual(json.loads((root/'received.json').read_text())['signal'],signum)
                if not forced:
                    wait_file(root/'cleanup-started.json',parent)
                    self.assertFalse((root/'pg-stopped.json').exists())
                    (root/'release').touch()
                stdout,stderr=parent.communicate(timeout=10)
                self.assertEqual(parent.returncode,0,stderr)
                result=json.loads((root/'pg-stopped.json').read_text())
                self.assertTrue(result['childStopped'])
                self.assertEqual(result['forced'],forced)
                self.assertEqual(result['cleanupRequiresManifestReview'],forced)
                self.assertEqual(result['childFinishedBeforePgStop'],not forced)
                self.assertFalse(Path(f'/proc/{child_pid}').exists())
            finally:
                if parent.poll() is None:
                    os.killpg(parent.pid,signal.SIGKILL);parent.communicate(timeout=5)
                pending=root/'pending.json'
                if pending.exists():
                    pid=json.loads(pending.read_text())['pid']
                    if Path(f'/proc/{pid}').exists():
                        try: os.killpg(pid,signal.SIGKILL)
                        except ProcessLookupError: pass

    def test_sigterm_launcher_forwards_and_waits_for_cleanup_before_pg_stop(self):
        self.run_signal(signal.SIGTERM,False)

    def test_sigint_launcher_group_keeps_child_cleanup_before_pg_stop(self):
        self.run_signal(signal.SIGINT,True)

    def test_unresponsive_child_is_bounded_and_manifest_review_is_required(self):
        self.run_signal(signal.SIGTERM,False,True)


if __name__=='__main__':
    unittest.main(verbosity=2)
