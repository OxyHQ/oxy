import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { OxyServices } from '@oxy.so/core';
import { signMessage } from '@oxy.so/protocol/sign';

test('the actual Mention-origin Alia conversation remains readable only by its QA owner', {
  skip: process.env.OXY_QA_LIVE !== '1',
  timeout: 45000,
}, async () => {
  const { readIdentity, directory } = await import('./qa.mjs');
  const owned = JSON.parse(await fs.readFile(`${directory}/alia-conversations.json`, 'utf8'));
  assert.equal(owned.conversations.length, 1);
  assert.equal(owned.conversations[0].title, 'QA_OK');
  const id = owned.conversations[0].id;
  const receipt = { observedAt: new Date().toISOString(), conversationId: id, accounts: [] };
  for (const slot of ['a', 'b']) {
    const identity = await readIdentity(slot);
    if (slot === 'a') assert.equal(identity.accountId, owned.accountId);
    else assert.notEqual(identity.accountId, owned.accountId);
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
        'QA ownership readback',
      );
      assert.equal(session.user.id, identity.accountId);
      linked = oxy.createLinkedClient({ baseURL: 'https://api.alia.onl' });
      const response = await linked.client.requestAuthenticatedResponse({
        method: 'GET',
        url: `/conversations/${encodeURIComponent(id)}`,
      });
      assert.equal(response.status, slot === 'a' ? 200 : 404);
      const metadata = { slot, accountId: identity.accountId, status: response.status };
      if (slot === 'a') {
        const data = await response.json();
        assert.equal(data.app, 'mention');
        assert.equal(data.title, 'QA_OK');
        assert.ok(
          data.messages.some(
            (message) =>
              message.role === 'assistant' &&
              typeof message.content === 'string' &&
              message.content.length > 0,
          ),
        );
        metadata.messageCount = data.messages.length;
        metadata.toolInvocationCount = data.messages.reduce(
          (count, message) => count + (message.toolInvocations?.length ?? 0),
          0,
        );
      } else await response.body?.cancel();
      receipt.accounts.push(metadata);
    } finally {
      linked?.dispose();
      oxy.dispose();
    }
  }
  receipt.success = true;
  await fs.writeFile(
    `${directory}/alia-ownership-${Date.now()}.json`,
    JSON.stringify(receipt, null, 2),
    { mode: 0o600, flag: 'wx' },
  );
});
