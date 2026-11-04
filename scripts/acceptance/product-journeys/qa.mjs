import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { OxyServices } from '@oxy.so/core';
import { signMessage } from '@oxy.so/protocol/sign';
import { PURPOSE, validateIdentity, validateApproval } from './guards.mjs';

export const directory = process.env.OXY_QA_DIR;
assert.ok(
  directory && path.isAbsolute(directory),
  'OXY_QA_DIR must name an explicit absolute private directory',
);
const networkOptions = { cache: false, retry: false, timeout: 15000 };

async function privateDirectory() {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const st = await fs.lstat(directory);
  assert.ok(st.isDirectory() && !st.isSymbolicLink());
  assert.equal(st.mode & 0o077, 0, 'QA directory must be private');
}

function identityPath(slot) {
  assert.ok(['a', 'b'].includes(slot), 'Only the two reviewed QA slots are allowed');
  return path.join(directory, `${slot}.json`);
}

export async function readIdentity(slot) {
  await privateDirectory();
  const file = identityPath(slot);
  const st = await fs.lstat(file);
  assert.ok(st.isFile() && !st.isSymbolicLink());
  assert.equal(st.mode & 0o077, 0);
  const identity = JSON.parse(await fs.readFile(file, 'utf8'));
  validateIdentity(identity);
  return identity;
}

async function saveIdentity(slot, identity, exclusive = false) {
  await privateDirectory();
  const destination = identityPath(slot);
  if (exclusive) {
    await fs.writeFile(destination, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
    return;
  }
  const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
  const file = await fs.open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(identity));
    await file.sync();
  } finally {
    await file.close();
  }
  await fs.rename(temporary, destination);
}

export async function signedApproval(slot, code, origin) {
  const identity = await readIdentity(slot);
  assert.ok(identity.accountId, 'Register the dedicated QA identity first');
  const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
  try {
    const info = await oxy.auth.commons.approvalInfo(code);
    validateApproval(info, origin);
    const { challenge } = await oxy.auth.requestChallenge(identity.publicKey, networkOptions);
    const timestamp = Date.now();
    const signature = await signMessage(
      `auth:${identity.publicKey}:${challenge}:${timestamp}`,
      identity.privateKey,
    );
    const result = await oxy.request(
      'POST',
      `/auth/session/authorize-signed/${encodeURIComponent(code)}`,
      {
        publicKey: identity.publicKey,
        challenge,
        signature,
        timestamp,
        deviceName: 'Dedicated cross-product QA browser',
      },
      { ...networkOptions, skipAuth: true },
    );
    assert.equal(result.user.id, identity.accountId);
    return { accountId: identity.accountId, username: identity.username };
  } finally {
    oxy.dispose();
  }
}

export async function run(mode, slot, exactAccountId) {
  if (mode === 'prepare') {
    const { KeyManager } = await import('@oxy.so/core/crypto');
    const keys = await KeyManager.generateKeyPair();
    const identity = {
      ...keys,
      purpose: PURPOSE,
      username: `oxyqa${randomBytes(7).toString('hex')}`,
      createdAt: new Date().toISOString(),
    };
    await saveIdentity(slot, identity, true);
    return { prepared: true, slot };
  }
  assert.ok(['register', 'authenticate', 'delete'].includes(mode));
  const identity = await readIdentity(slot);
  if (mode === 'delete') {
    assert.ok(
      typeof exactAccountId === 'string' && exactAccountId.length > 0,
      'Delete requires the exact QA account id',
    );
    validateIdentity(identity, exactAccountId);
  }
  const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
  try {
    if (mode === 'register') {
      assert.ok(!identity.accountId, 'Never re-register a persisted QA account');
      const timestamp = Date.now();
      const signature = await signMessage(
        `oxy:register:${identity.publicKey}:${timestamp}`,
        identity.privateKey,
      );
      const result = await oxy.auth.registerKey(
        identity.publicKey,
        signature,
        timestamp,
        identity.username,
      );
      assert.ok(result.user?.id);
      identity.accountId = result.user.id;
      await saveIdentity(slot, identity);
    } else {
      const { challenge } = await oxy.auth.requestChallenge(identity.publicKey, networkOptions);
      const timestamp = Date.now();
      const signature = await signMessage(
        `auth:${identity.publicKey}:${challenge}:${timestamp}`,
        identity.privateKey,
      );
      const session = await oxy.auth.verifyChallenge(
        identity.publicKey,
        challenge,
        signature,
        timestamp,
        'Dedicated acceptance cleanup',
        undefined,
        networkOptions,
      );
      // Recover registration after a local save failure using only its original key.
      if (!identity.accountId) {
        assert.equal(mode, 'authenticate');
        assert.equal(session.user.username, identity.username);
        identity.accountId = session.user.id;
        await saveIdentity(slot, identity);
      }
      assert.equal(session.user.id, identity.accountId);
      const me = await oxy.users.me({ cache: false });
      assert.equal(me.id, identity.accountId);
      assert.equal(me.username, identity.username);
      if (mode === 'delete') {
        const deletedAt = Date.now();
        const proof = await signMessage(
          `delete:${identity.publicKey}:${deletedAt}`,
          identity.privateKey,
        );
        await oxy.request(
          'DELETE',
          '/users/me',
          { confirmText: identity.username, signature: proof, timestamp: deletedAt },
          networkOptions,
        );
        let refused = false;
        try {
          await oxy.request('GET', '/users/me', undefined, networkOptions);
        } catch (error) {
          if (error.status !== 401) throw error;
          refused = true;
        }
        assert.ok(refused, 'Deleted QA bearer must be refused');
        await fs.writeFile(
          path.join(directory, `${slot}-deleted.json`),
          JSON.stringify({
            accountId: identity.accountId,
            deletedAt: new Date().toISOString(),
            bearerRefused: true,
          }),
          { mode: 0o600, flag: 'wx' },
        );
        await fs.unlink(identityPath(slot));
      } else {
        identity.session = { accessToken: session.accessToken, sessionId: session.sessionId };
        await saveIdentity(slot, identity);
      }
    }
    return { mode, slot, accountId: identity.accountId, username: identity.username };
  } finally {
    oxy.dispose();
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    console.log(JSON.stringify({ success: true, ...(await run(...process.argv.slice(2))) }));
  } catch (error) {
    // Do not print bodies, headers, URLs or stacks from authenticated requests.
    console.error(
      JSON.stringify({
        success: false,
        errorName: error.name,
        code: error.code ?? null,
        status: error.status ?? null,
      }),
    );
    process.exitCode = 1;
  }
}
