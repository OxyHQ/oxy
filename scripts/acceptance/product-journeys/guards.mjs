import assert from 'node:assert/strict';

export const PURPOSE = 'cross-product acceptance 2026-10-26';
export const ORIGINS = new Set([
  'https://console.oxy.so',
  'https://mention.earth',
  'https://alia.onl',
]);

export function validateIdentity(identity, exactAccountId) {
  assert.equal(identity.purpose, PURPOSE);
  assert.match(identity.username, /^oxyqa[0-9a-f]{14}$/);
  assert.ok(identity.publicKey && identity.privateKey);
  if (exactAccountId !== undefined) {
    assert.ok(identity.accountId);
    assert.equal(identity.accountId, exactAccountId, 'Cleanup must name this exact QA account');
  }
}

export function validateApproval(info, origin) {
  assert.ok(ORIGINS.has(origin), 'Only reviewed product origins are allowed');
  assert.equal(info.boundOrigin, origin);
  assert.equal(info.originVerified, true);
  assert.equal(info.purpose, 'device_sign_in');
  assert.equal(info.status, 'pending');
  assert.ok(!info.subjectAccount, 'No delegated account approval in this fixture');
  assert.ok(!info.scopes || info.scopes.length === 0, 'Own sign-in must not request scopes');
  assert.ok(Date.parse(info.expiresAt) > Date.now(), 'Approval request expired');
}
