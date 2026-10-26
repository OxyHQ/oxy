import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { OxyServices } from '@oxy.so/core';
import { signMessage } from '@oxy.so/protocol/sign';
import { readIdentity, directory } from './qa.mjs';
const identity = await readIdentity('a');
const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
let linked;
try {
  const { challenge } = await oxy.auth.requestChallenge(identity.publicKey, {
    cache: false,
    retry: false,
  });
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
    'QA conversation readback',
  );
  assert.equal(session.user.id, identity.accountId);
  linked = oxy.createLinkedClient({ baseURL: 'https://api.alia.onl' });
  const res = await linked.client.requestAuthenticatedResponse({
    method: 'GET',
    url: '/conversations?app=mention&limit=10',
    headers: { Origin: 'https://mention.earth' },
  });
  const cookieNames = res.headers.getSetCookie().map((h) => h.slice(0, h.indexOf('=')));
  assert.equal(res.status, 200);
  const data = await res.json();
  const conversations = data.conversations ?? data.data?.conversations;
  assert.ok(Array.isArray(conversations));
  const output = {
    observedAt: new Date().toISOString(),
    accountId: identity.accountId,
    status: res.status,
    cookieNames,
    conversations: conversations.map((c) => ({
      id: c.id ?? c._id,
      title: c.title,
      app: c.app,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })),
  };
  await fs.writeFile(`${directory}/alia-conversations.json`, JSON.stringify(output), {
    mode: 0o600,
  });
  console.log(JSON.stringify(output));
} finally {
  linked?.dispose();
  oxy.dispose();
}
