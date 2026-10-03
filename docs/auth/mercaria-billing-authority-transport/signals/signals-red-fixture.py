#!/usr/bin/env python3
"""Real process signals; AWS is a local stateful fixture, no network or SQL."""
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import unittest

CHILD = r'''
import importlib.util,json,os,sys,time
from pathlib import Path
spec=importlib.util.spec_from_file_location('fixture',sys.argv[1]);fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
f=fixture.Fixtures();f.setUp();m=fixture.m
out=Path(sys.argv[2]);phase=sys.argv[3];state={'run':0,'stop':0,'deregister':0,'describes':0,'stopped':False}
def save(): (out.parent/'aws-state.json').write_text(json.dumps(state))
def ready():
 print('READY',flush=True)
 while True: time.sleep(0.1)
def aws(*args):
 action=args[1]
 definition=m.build_definition(f.plan)
 td=definition|{'taskDefinitionArn':'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-mercaria-billing-authority:1','status':'ACTIVE'}
 if action=='register-task-definition':return {'taskDefinition':td}
 if action=='describe-task-definition':return 'INACTIVE' if '--query' in args else {'taskDefinition':td}
 if action=='run-task':
  state['run']+=1;save()
  if phase=='unknown':ready()
  return {'tasks':[{'taskArn':'arn:aws:ecs:us-west-2:237343248947:task/oxy-cluster/owned'}]}
 if action=='describe-tasks':
  state['describes']+=1;save()
  if phase in ('ack','stop-fails') and state['describes']==1:ready()
  return {'tasks':[{'taskDefinitionArn':td['taskDefinitionArn'],'lastStatus':'STOPPED' if phase=='receipt' or state['stopped'] else 'RUNNING','containers':[{'exitCode':0,'imageDigest':'sha256:'+'b'*64}]}]}
 if action=='stop-task':
  state['stop']+=1;save()
  if phase=='stop-fails':raise RuntimeError('synthetic stop failure')
  state['stopped']=True;save();return {}
 if action=='deregister-task-definition':state['deregister']+=1;save();return {}
 raise AssertionError(action)
m.aws=aws;m.operator=lambda _:f.plan['operator'];m.transport.describe=lambda _:f.plan['live'];m.collect=lambda *_:ready()
try:m.execute(f.plan,out)
except BaseException:sys.exit(1)
finally:f.tearDown()
'''

class Signals(unittest.TestCase):
    def run_phase(self,phase):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);os.chmod(root,0o700)
            test=Path(__file__).with_name('test-mercaria-billing-authority-ecs.py')
            process=subprocess.Popen([sys.executable,'-B','-c',CHILD,str(test),str(root/'execution'),phase],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            try:
                readable,_,_=select.select([process.stdout],[],[],10)
                self.assertTrue(readable,'fixture never reached signal boundary')
                self.assertEqual(process.stdout.readline().strip(),'READY')
                process.send_signal(signal.SIGTERM)
                stdout,stderr=process.communicate(timeout=10)
                self.assertEqual(process.returncode,1,(stdout,stderr))
                state=json.loads((root/'aws-state.json').read_text())
                self.assertEqual(state['run'],1)
                self.assertEqual(state['deregister'],1)
                interrupt=json.loads((root/'execution/interrupt.json').read_text())
                self.assertEqual(interrupt['signal'],'SIGTERM')
                self.assertTrue(interrupt['manualReconciliationRequired'])
                cleanup=json.loads((root/'execution/cleanup.json').read_text())
                self.assertTrue(cleanup['definitionInactive'])
                self.assertEqual((root/'execution/result.private.json').read_bytes(),b'')
                if phase=='stop-fails':
                    self.assertEqual(state['stop'],1)
                    self.assertIn('task_cleanup_failed',cleanup['failures'])
                elif phase=='unknown':
                    self.assertEqual(state['stop'],0)
                    self.assertFalse(cleanup['taskStopped'])
                    self.assertTrue((root/'execution/registered.json').exists())
                    self.assertFalse((root/'execution/launch.json').exists())
                else:self.assertTrue(cleanup['taskStopped'])
            finally:
                if process.poll() is None:process.kill();process.wait()
    def test_sigterm_after_ack(self):self.run_phase('ack')
    def test_sigterm_waiting_for_receipt(self):self.run_phase('receipt')
    def test_sigterm_cleanup_stop_failure_still_deregisters(self):self.run_phase('stop-fails')
    def test_sigterm_unknown_run_ack_retains_identity_without_redispatch(self):self.run_phase('unknown')

if __name__=='__main__':unittest.main()
