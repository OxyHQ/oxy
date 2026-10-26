import assert from 'node:assert/strict';
import test from 'node:test';
import { validateApproval, validateIdentity, PURPOSE } from './guards.mjs';

test('a real pending own request may be approved only for the observed product origin', () => {
  const request = {
    boundOrigin: 'https://console.oxy.so',
    originVerified: true,
    purpose: 'device_sign_in',
    status: 'pending',
    scopes: [],
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  assert.doesNotThrow(() => validateApproval(request, request.boundOrigin));
  for (const changed of [
    { boundOrigin: 'https://mention.earth' },
    { originVerified: false },
    { purpose: 'oauth_authorization' },
    { status: 'authorized' },
    { scopes: ['files:read'] },
    { subjectAccount: { id: 'another-account' } },
    { expiresAt: new Date(0).toISOString() },
  ])
    assert.throws(() => validateApproval({ ...request, ...changed }, request.boundOrigin));
  assert.throws(() => validateApproval(request, 'https://console.oxy.so.attacker.test'));
});

test('cleanup cannot target another account or an existing non-QA identity', () => {
  const identity = {
    purpose: PURPOSE,
    username: 'oxyqa0123456789abcd',
    publicKey: 'fixture',
    privateKey: 'fixture',
    accountId: 'dedicated-a',
  };
  assert.doesNotThrow(() => validateIdentity(identity, 'dedicated-a'));
  assert.throws(() => validateIdentity(identity, 'dedicated-b'));
  assert.throws(() => validateIdentity({ ...identity, purpose: 'personal' }, 'dedicated-a'));
  assert.throws(() =>
    validateIdentity({ ...identity, username: 'existing-person' }, 'dedicated-a'),
  );
});
