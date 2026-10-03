import ast
import copy
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT=Path(__file__).parent

def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
inventory=load('new_inventory',ROOT/'commercial-inventory-ecs.py')
coordinator=load('coordinator',ROOT/'merchants-register-coordinator.py')

class Profiles(unittest.TestCase):
 def test_each_family_exact_new_revision(self):
  for profile in inventory.PROFILES:
   name=inventory.PROFILES[profile]['family']+':999'
   self.assertTrue(inventory.reviewed_definition(profile,name).endswith('/'+name))
 def test_old_revision_is_explicit_not_default(self):
  self.assertNotIn('definition',inventory.PROFILES['oxy'])
  with self.assertRaises(RuntimeError):inventory.reviewed_definition('oxy','')
 def test_cross_family_and_nonpositive_revision_denied(self):
  for name in ['oxy-clarity-api:999','oxy-oxy-api:0','oxy-oxy-api:1;touch x','arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-oxy-api:999']:
   with self.assertRaises(RuntimeError):inventory.reviewed_definition('oxy',name)
 def test_family_validation_precedes_aws(self):
  with patch.object(inventory,'aws',side_effect=AssertionError('must not call')):
   with self.assertRaises(RuntimeError):inventory.describe('oxy','oxy-mercaria:99')
 def test_all_projected_columns_match_final142(self):
  # Parse only the fixed source map (Node object syntax); compare every identifier to generated schema.
  import re
  source=inventory.READER.read_text()
  oxy=source.split('  oxy: {',1)[1].split('  clarity: {',1)[0]
  snapshot=json.loads(Path('/home/nate/Oxy/oxy/.worktrees/1519-final-integration-20261003/packages/api/drizzle/meta/0142_snapshot.json').read_text())
  seen=[]
  for line in oxy.splitlines():
   match=re.match(r'    ([a-z_]+): .*?\[([^\]]+)\]',line)
   if not match:continue
   table=match[1]; columns=re.findall(r"'([a-z_]+)'",match[2])
   if table=='billing_transactions': columns=['id','user_id','stripe_customer_id','stripe_subscription_id','stripe_invoice_id','stripe_subscription_period_start','type','amount_minor_units','currency','credits','status']
   actual=snapshot['tables']['public.'+table]['columns']
   self.assertTrue(set(columns)<=set(actual),table);seen.append(table)
  self.assertEqual(len(seen),17)
  for table in ['access_provider_periods','access_provider_events','billing_credit_invoices','billing_credit_spends','billing_credit_consumptions','billing_credit_refund_observations']:self.assertIn(table,seen)
  self.assertNotIn("'payload'",oxy);self.assertNotIn("'secret'",oxy)

class Coordinator(unittest.TestCase):
 def test_help_is_successful_without_operation(self):
  result=subprocess.run(['python3','-B',str(ROOT/'merchants-register-coordinator.py'),'--help'],capture_output=True,text=True)
  self.assertEqual(result.returncode,0);self.assertNotIn('OPERATION_FAILED',result.stderr)
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name);self.plan={'nonce':'synthetic','ephemeral':{'credentialId':'synthetic'}};self.config={'merchantPlanSha256':'a'*64,'merchantPlan':'/synthetic/plan'}
 def test_success_always_cleans_up(self):
  events=[]
  with patch.object(coordinator,'validate',return_value=self.plan):
   coordinator.execute(self.config,self.root/'output',lambda *a:events.append('merchant'),lambda *a:events.append('cleanup'))
  self.assertEqual(events,['merchant','cleanup']);r=json.loads((self.root/'output/receipt.json').read_text());self.assertTrue(r['credentialCleanupConfirmed'])
 def test_failure_still_cleans_up(self):
  events=[]
  def fail(*args):events.append('merchant');raise RuntimeError('private-not-logged')
  with patch.object(coordinator,'validate',return_value=self.plan):
   with self.assertRaises(RuntimeError):coordinator.execute(self.config,self.root/'output',fail,lambda *a:events.append('cleanup'))
  self.assertEqual(events,['merchant','cleanup']);self.assertNotIn('private-not-logged',(self.root/'output/receipt.json').read_text())
 def test_interrupt_still_cleans_up(self):
  events=[]
  def fail(*args):raise KeyboardInterrupt()
  with patch.object(coordinator,'validate',return_value=self.plan):
   with self.assertRaises(RuntimeError):coordinator.execute(self.config,self.root/'output',fail,lambda *a:events.append('cleanup'))
  self.assertEqual(events,['cleanup'])
 def test_cleanup_failure_never_success(self):
  def fail(*args):raise RuntimeError('unknown ACK')
  with patch.object(coordinator,'validate',return_value=self.plan):
   with self.assertRaises(RuntimeError):coordinator.execute(self.config,self.root/'output',lambda *a:None,fail)
  r=json.loads((self.root/'output/receipt.json').read_text());self.assertFalse(r['credentialCleanupConfirmed']);self.assertTrue(r['unknownRequiresReconciliation'])
 def test_existing_output_refused(self):
  (self.root/'output').mkdir()
  with patch.object(coordinator,'validate',return_value=self.plan):
   with self.assertRaises(FileExistsError):coordinator.execute(self.config,self.root/'output',lambda *a:self.fail(),lambda *a:self.fail())
 def test_private_files_and_symlinks(self):
  p=self.root/'source';p.write_text('{}');p.chmod(0o600);self.assertEqual(coordinator.read_private(p),b'{}')
  link=self.root/'link';link.symlink_to(p)
  with self.assertRaises(OSError):coordinator.read_private(link)
  p.chmod(0o644)
  with self.assertRaises(RuntimeError):coordinator.read_private(p)
 def test_canonical_cleanup_uses_fresh_inspect_then_revoke_receipt(self):
  original={'mode':'prepare','result':{'target':coordinator.TARGET,'credentialId':'synthetic-owned'}}
  source=self.root/'original.json';coordinator.durable(source,original)
  cfg={'ephemeralPrepare':str(source),'ephemeralPrepareSha256':coordinator.sha(source),'ephemeralLauncher':'/fixed/mercaria-ephemeral-ecs.py','definition':'oxy-oxy-api:999','operatorArn':'arn:aws:iam::237343248947:user/synthetic','material':'/private/material'}
  events=[]
  def run(args,phase,output):
   events.append(phase)
   def arg(name):return args[args.index(name)+1]
   if phase.endswith('-prepare'):
    folder=Path(arg('--output'));folder.mkdir(mode=0o700);coordinator.durable(folder/'plan.json',{'phase':phase})
    if phase=='revoke-prepare':self.assertIn('inspect-execution',arg('--input'))
   else:
    folder=Path(arg('--output'));folder.mkdir(mode=0o700);mode=phase.split('-')[0]
    coordinator.durable(folder/'result.private.json',{'mode':mode,'result':{'operation':mode,'plan':original['result'],'state':{'status':'revoked' if mode=='revoke' else 'active'}}})
  coordinator.cleanup(cfg,self.root,run)
  self.assertEqual(events,['inspect-prepare','inspect-execute','revoke-prepare','revoke-execute']);self.assertTrue(json.loads((self.root/'cleanup.json').read_text())['credentialRevoked'])
 def test_unknown_inspect_ack_stops_before_revoke(self):
  source=self.root/'original.json';coordinator.durable(source,{'mode':'prepare','result':{'target':coordinator.TARGET}})
  cfg={'ephemeralPrepare':str(source),'ephemeralPrepareSha256':coordinator.sha(source),'ephemeralLauncher':'/fixed/mercaria-ephemeral-ecs.py','definition':'oxy-oxy-api:999','operatorArn':'arn:aws:iam::237343248947:user/synthetic','material':'/private/material'}
  events=[]
  def run(args,phase,output):
   events.append(phase)
   if phase=='inspect-prepare':
    folder=Path(args[args.index('--output')+1]);folder.mkdir(mode=0o700);coordinator.durable(folder/'plan.json',{'phase':phase})
   else:raise RuntimeError('unknown ACK')
  with self.assertRaises(RuntimeError):coordinator.cleanup(cfg,self.root,run)
  self.assertEqual(events,['inspect-prepare','inspect-execute']);self.assertFalse((self.root/'cleanup.json').exists())
 def test_real_child_interrupt_terminal_before_return(self):
  # Black-box local child only; no AWS subprocess or credential material.
  original=subprocess.Popen;started=threading.Event();pid=[]
  def spawn(*args,**kwargs):
   child=original(*args,**kwargs);pid.append(child.pid);started.set();return child
  def alarm(signum,frame):raise KeyboardInterrupt()
  previous=signal.signal(signal.SIGALRM,alarm)
  try:
   with patch.object(coordinator.subprocess,'Popen',side_effect=spawn):
    signal.setitimer(signal.ITIMER_REAL,0.1)
    with self.assertRaises(KeyboardInterrupt):coordinator.command(['python3','-B','-c','import time;time.sleep(10)'],'child',self.root)
   self.assertTrue(started.is_set())
   with self.assertRaises(ProcessLookupError):os.kill(pid[0],0)
  finally:signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous)

if __name__=='__main__':unittest.main(verbosity=2)
