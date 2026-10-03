"""Root-only one merchant operation, followed by canonical exact-credential cleanup."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess

NODE = Path(__file__).with_name('merchants-register.mjs')
TARGET = {'applicationId': '6a37d0cc5d4b5f15482a9340', 'ownerAccountId': '69b2d3df5d12f58c9800d651'}


def require(ok, code):
    if not ok: raise RuntimeError(code)


def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_private(path):
    path = Path(path); parent = path.parent.lstat()
    require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == os.getuid() and stat.S_IMODE(parent.st_mode) == 0o700, 'private_parent_required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 65536, 'private_file_required')
        return os.read(fd, 65537)
    finally: os.close(fd)


def durable(path, value):
    parent = Path(path).parent.lstat()
    require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == os.getuid() and stat.S_IMODE(parent.st_mode) == 0o700, 'private_parent_required')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as f: json.dump(value, f, indent=2); f.write('\n'); f.flush(); os.fsync(f.fileno())
    fd = os.open(Path(path).parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def validate(plan):
    fields = {'kind','schemaVersion','merchantPlan','merchantPlanSha256','ephemeralPrepare','ephemeralPrepareSha256','material','ephemeralLauncher','ephemeralLauncherSha256','transportSha256','readerSha256','definition','operatorArn','nodeSha256','coordinatorSha256'}
    require(set(plan) == fields and plan['kind'] == 'mercaria-merchant-and-canonical-cleanup' and plan['schemaVersion'] == 1, 'coordinator_plan_shape')
    require(plan['nodeSha256'] == sha(NODE) and plan['coordinatorSha256'] == sha(__file__), 'coordinator_source_drift')
    launcher = Path(plan['ephemeralLauncher'])
    require(launcher.name == 'mercaria-ephemeral-ecs.py' and plan['ephemeralLauncherSha256'] == sha(launcher), 'cleanup_launcher_drift')
    base = launcher.parents[1] / 'billing/commercial-inventory-ecs.py'
    require(plan['transportSha256'] == sha(base) and plan['readerSha256'] == sha(base.with_name('read-commercial-inventory.mjs')), 'cleanup_transport_drift')
    require(re.fullmatch('oxy-oxy-api:[1-9][0-9]*', plan['definition']) and re.fullmatch(r'arn:aws:(iam|sts)::237343248947:.+', plan['operatorArn']), 'cleanup_target_drift')
    raw = read_private(plan['merchantPlan']); require(hashlib.sha256(raw).hexdigest() == plan['merchantPlanSha256'], 'merchant_plan_hash_drift')
    merchant = json.loads(raw)
    original = read_private(plan['ephemeralPrepare']); require(hashlib.sha256(original).hexdigest() == plan['ephemeralPrepareSha256'], 'prepare_receipt_hash_drift')
    prepare = json.loads(original)
    require(prepare['mode'] == 'prepare' and prepare['result']['target'] == TARGET and prepare['result'] == merchant['ephemeral'] and merchant['config']['material'] == plan['material'], 'cleanup_identity_mismatch')
    read_private(plan['material'])
    return merchant


def command(args, phase, output):
    # No dotenv, token or provider secret is inherited; subprocess stdout/stderr withheld.
    env = {key: os.environ[key] for key in ['PATH','HOME','LANG','LC_ALL','AWS_PROFILE','AWS_CONFIG_FILE','AWS_SHARED_CREDENTIALS_FILE','AWS_REGION','AWS_DEFAULT_REGION'] if key in os.environ}
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    with open(output / (phase + '.log'), 'xb') as log:
        os.chmod(log.name, 0o600)
        process = subprocess.Popen(args, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=240)
        except BaseException:
            # Child must be terminal before credential cleanup; SIGINT runs Python finally.
            try: os.killpg(process.pid, signal.SIGINT)
            except ProcessLookupError: pass
            try: process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                try: os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                process.wait(timeout=5)
            raise
        finally:
            log.flush(); os.fsync(log.fileno())
    require(code == 0, phase + '_failed_reconcile_no_retry')


def cleanup(plan, output, run_command=command):
    source = plan['ephemeralPrepare']; input_sha = plan['ephemeralPrepareSha256']; launcher = plan['ephemeralLauncher']
    for mode in ['inspect', 'revoke']:
        folder = output / (mode + '-plan'); target = folder / 'plan.json'
        args = ['python3', '-B', launcher, '--mode', mode, '--definition', plan['definition'], '--expected-operator-arn', plan['operatorArn'], '--input', str(source), '--input-sha256', input_sha, '--material', plan['material'], '--plan', str(target), '--output', str(folder)]
        durable(output / (mode + '-prepare-intent.json'), {'mode': mode, 'originalPrepareSha256': plan['ephemeralPrepareSha256'], 'inputSha256': input_sha})
        run_command(args, mode + '-prepare', output)
        execution = output / (mode + '-execution')
        durable(output / (mode + '-execute-intent.json'), {'mode': mode, 'planFileSha256': sha(target), 'oneAttempt': True})
        run_command(['python3', '-B', launcher, '--execute', '--plan', str(target), '--plan-sha256', sha(target), '--material', plan['material'], '--output', str(execution)], mode + '-execute', output)
        source = execution / 'result.private.json'; raw = read_private(source); receipt = json.loads(raw); input_sha = hashlib.sha256(raw).hexdigest()
        require(receipt['mode'] == mode and receipt['result']['operation'] == mode and receipt['result']['plan']['target'] == TARGET and receipt['result']['plan'] == json.loads(read_private(plan['ephemeralPrepare']))['result'], 'cleanup_receipt_wrong_identity')
        if mode == 'revoke': require(receipt['result']['state']['status'] == 'revoked', 'cleanup_revocation_not_confirmed')
    durable(output / 'cleanup.json', {'credentialRevoked': True, 'revokeReceiptSha256': input_sha, 'materialRetainedForOperatorRemoval': True, 'alreadyIssuedJwtMayRemainUntilExp': True})


def execute(plan, output, run_command=command, run_cleanup=cleanup):
    merchant = validate(plan); output = Path(output); output.mkdir(mode=0o700, parents=False, exist_ok=False)
    durable(output / 'intent.json', {'merchantPlanSha256': plan['merchantPlanSha256'], 'credentialId': merchant['ephemeral']['credentialId'], 'nonce': merchant['nonce'], 'cleanupRequired': True})
    failure = None; cleanup_failure = None
    try:
        run_command(['node', str(NODE), 'execute', plan['merchantPlan'], str(output / 'merchant-result.json'), plan['merchantPlanSha256']], 'merchant', output)
    except BaseException as error: failure = type(error).__name__
    finally:
        # The credential existed before this helper; even Node validation failure requires cleanup.
        try: run_cleanup(plan, output)
        except BaseException as error: cleanup_failure = type(error).__name__
        durable(output / 'receipt.json', {'merchantCompleted': failure is None, 'credentialCleanupConfirmed': cleanup_failure is None, 'failureKind': failure, 'cleanupFailureKind': cleanup_failure, 'unknownRequiresReconciliation': failure is not None or cleanup_failure is not None})
    require(failure is None and cleanup_failure is None, 'operation_or_cleanup_failed_reconcile_receipts')


def main():
    p = argparse.ArgumentParser(); p.add_argument('--config'); p.add_argument('--plan', required=True); p.add_argument('--plan-sha256'); p.add_argument('--execute', action='store_true'); p.add_argument('--output')
    a = p.parse_args()
    if a.execute:
        require(a.output and not a.config and a.plan_sha256 == hashlib.sha256(read_private(a.plan)).hexdigest(), 'reviewed_plan_required')
        def interrupted(signum, frame): raise KeyboardInterrupt()
        signal.signal(signal.SIGTERM, interrupted); signal.signal(signal.SIGINT, interrupted)
        execute(json.loads(read_private(a.plan)), a.output); print('MERCHANT_AND_CREDENTIAL_CLEANUP_COMPLETE')
    else:
        require(a.config and not a.execute and not a.output and not a.plan_sha256, 'prepare_only_shape')
        plan = json.loads(read_private(a.config)); plan.update(kind='mercaria-merchant-and-canonical-cleanup', schemaVersion=1, nodeSha256=sha(NODE), coordinatorSha256=sha(__file__))
        validate(plan); durable(a.plan, plan); print(json.dumps({'prepared': True, 'planFileSha256': sha(a.plan), 'executed': False}))

if __name__ == '__main__':
    try: main()
    except (Exception, KeyboardInterrupt):
        print('MERCHANT_OPERATION_FAILED: inspect durable intent, reconcile original task and revoke exact credential; no retry', file=os.sys.stderr); raise SystemExit(1)
