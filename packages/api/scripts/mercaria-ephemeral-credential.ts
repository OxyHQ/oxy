#!/usr/bin/env bun
/** Internal operator entrypoint; no public credential API or grants are changed. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync } from 'node:fs';
import { z } from 'zod';
import { closePostgres, connectPostgres } from '../src/config/postgres';
import {
  inspectSchema,
  materialSchema,
  planSchema,
  target,
} from '../src/services/mercariaEphemeralCredential.contract';
import {
  inspectEphemeralCredential,
  issueEphemeralCredential,
  prepareEphemeralCredential,
  revokeEphemeralCredential,
} from '../src/services/mercariaEphemeralCredential.service';
import { credentialVerifier, generateCredentialMaterial } from '../src/utils/credentialMaterial';
import {
  readPrivateFile,
  reservePrivateFile,
  writePrivateJson,
} from '../src/utils/privateOperatorFiles';
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error('invalid_operator_invocation');
  return value;
}
async function main() {
  const mode = z.enum(['prepare', 'material', 'issue', 'inspect', 'revoke']).parse(process.argv[2]);
  const identity = z.object({ Account: z.literal('237343248947'), Arn: z.string().min(1) }).parse(
    JSON.parse(
      execFileSync('aws', ['sts', 'get-caller-identity', '--output', 'json'], {
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ),
  );
  if (identity.Arn !== required('EXPECTED_OPERATOR_ARN'))
    throw new Error('operator_identity_mismatch');
  // STS attributes the authorized DB operator; it does not grant DB access or invent a user principal.
  const actor = { isPlatformStaff: true, describedAs: identity.Arn };
  let input: unknown;
  if (mode !== 'prepare' && mode !== 'material') {
    const bytes = readPrivateFile(required('EPHEMERAL_INPUT'));
    if (createHash('sha256').update(bytes).digest('hex') !== required('EPHEMERAL_INPUT_SHA256'))
      throw new Error('input_hash_mismatch');
    input = JSON.parse(bytes.toString());
  }
  const inspected = mode === 'revoke' ? inspectSchema.parse(input) : undefined;
  const plan =
    mode === 'prepare' || mode === 'material'
      ? undefined
      : (inspected?.plan ?? planSchema.parse(input));
  let material =
    mode === 'prepare' || mode === 'material' || mode === 'issue'
      ? undefined
      : materialSchema.parse(
          JSON.parse(readPrivateFile(required('EPHEMERAL_MATERIAL')).toString()),
        );
  const descriptors: number[] = [];
  try {
    // All output paths must be new files under an operator-owned 0700 directory.
    // A failed reservation happens before any DB mutation. Pending survives a lost ACK.
    const output = required('EPHEMERAL_OUTPUT');
    const pendingFd = reservePrivateFile(output);
    descriptors.push(pendingFd);
    const resultFd = reservePrivateFile(`${output}.result.json`);
    descriptors.push(resultFd);
    writePrivateJson(pendingFd, {
      pending: true,
      mode,
      actor: identity.Arn,
      target,
      credentialId: plan?.credentialId,
      nonce: plan?.nonce,
    });
    if (mode === 'issue' || mode === 'material') {
      const materialFd = reservePrivateFile(required('EPHEMERAL_MATERIAL'));
      descriptors.push(materialFd);
      material = generateCredentialMaterial();
      writePrivateJson(materialFd, material); // fsync BEFORE issue transaction; never regenerate on uncertain commit.
    }
    if (mode === 'material') {
      writePrivateJson(resultFd, {
        operation: 'material',
        actor: identity.Arn,
        target,
      });
      process.stdout.write('MERCARIA_EPHEMERAL_OK material\n');
      return;
    }
    await connectPostgres();
    const result =
      mode === 'prepare'
        ? await prepareEphemeralCredential(target, actor)
        : mode === 'issue' && plan && material
          ? await issueEphemeralCredential(plan, credentialVerifier(material), actor)
          : mode === 'inspect' && plan && material
            ? await inspectEphemeralCredential(plan, credentialVerifier(material), actor)
            : mode === 'revoke' && inspected && material
              ? await revokeEphemeralCredential(
                  inspected.plan,
                  credentialVerifier(material),
                  inspected.state,
                  actor,
                )
              : (() => {
                  throw new Error('invalid_operator_invocation');
                })();
    writePrivateJson(resultFd, result);
    process.stdout.write(`MERCARIA_EPHEMERAL_OK ${mode}\n`);
  } finally {
    material = undefined; // No claim of erasing immutable JS strings or durable files.
    for (const fd of descriptors) closeSync(fd);
    await closePostgres();
  }
}
void main().catch(() => {
  process.stderr.write(
    'MERCARIA_EPHEMERAL_FAILED: inspect private receipts and reconcile exact ID/nonce; no automatic retry\n',
  );
  process.exitCode = 1;
});
