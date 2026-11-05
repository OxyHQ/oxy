import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { OxyServices } from '@oxy.so/core';
import { signMessage } from '@oxy.so/protocol/sign';
import { readIdentity, directory } from './qa.mjs';
const maxTokens = Number(process.env.OXY_QA_CANCEL_MAX_TOKENS ?? 64);
assert.ok([64, 256].includes(maxTokens), 'Only reviewed cancellation caps are allowed');
const receiptPrefix = maxTokens === 64 ? 'alia-cancel' : 'alia-cancel-256';
assert.equal(
  await fs.access(`${directory}/${receiptPrefix}-receipt.json`).then(
    () => true,
    () => false,
  ),
  false,
  'Never repeat an already observed production generation',
);
await fs.writeFile(
  `${directory}/${receiptPrefix}-attempt.json`,
  JSON.stringify({ startedAt: new Date().toISOString(), requests: 1 }),
  { mode: 0o600, flag: 'wx' },
);
const identity = await readIdentity('a');
const owned = JSON.parse(await fs.readFile(`${directory}/alia-conversations.json`, 'utf8'));
assert.equal(owned.accountId, identity.accountId);
assert.equal(owned.conversations.length, 1);
assert.equal(owned.conversations[0].title, 'QA_OK');
const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
let linked;
const receipt = {
  startedAt: new Date().toISOString(),
  accountId: identity.accountId,
  conversationId: owned.conversations[0].id,
  kind: 'API cancellation through public Core linked transport; not a UI stop test',
  maxTokens,
  model: 'instant',
  requests: 1,
  toolCalls: 0,
  contentFrames: 0,
};
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
    'QA cancellation acceptance',
  );
  assert.equal(session.user.id, identity.accountId);
  linked = oxy.createLinkedClient({ baseURL: 'https://api.alia.onl' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await linked.client.requestAuthenticatedResponse({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'instant',
        stream: true,
        max_tokens: maxTokens,
        conversationId: owned.conversations[0].id,
        messages: [
          {
            role: 'user',
            content:
              maxTokens === 64
                ? 'Count from one to thirty in words. Do not use tools, search, delegate, or take any external action.'
                : 'Write a numbered list from one to one hundred, spelling out each number on its own line. Do not use tools, search, delegate, or take any external action.',
          },
        ],
      }),
    });
    receipt.headersAt = new Date().toISOString();
    receipt.contentEncoding = res.headers.get('content-encoding');
    receipt.contentType = res.headers.get('content-type');
    receipt.httpStatus = res.status;
    receipt.transportChunks = [];
    assert.equal(res.status, 200);
    assert.ok(res.body);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let cancelReason;
    while (!cancelReason) {
      const next = await reader.read();
      if (next.done) {
        receipt.endedBeforeCancellation = true;
        break;
      }
      receipt.transportChunks.push({ at: new Date().toISOString(), bytes: next.value.byteLength });
      buffer += decoder.decode(next.value, { stream: true });
      while (buffer.includes('\n\n')) {
        const end = buffer.indexOf('\n\n');
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const line = frame.split('\n').find((x) => x.startsWith('data: '));
        if (!line || line === 'data: [DONE]') continue;
        let data;
        try {
          data = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (data.id) receipt.requestId = data.id;
        if (data.error) {
          receipt.errorCode = data.error.code;
          cancelReason = 'upstream-error';
          break;
        }
        if (data.choices?.some((c) => c.delta?.tool_calls?.length) || frame.includes('alia.tool')) {
          receipt.toolCalls++;
          cancelReason = 'tool-request-refused';
          break;
        }
        if (data.choices?.some((c) => c.delta?.content)) {
          receipt.contentFrames++;
          cancelReason = 'first-content';
          break;
        }
      }
    }
    if (cancelReason) {
      receipt.cancelReason = cancelReason;
      receipt.cancelledAt = new Date().toISOString();
      controller.abort();
      try {
        await reader.read();
        receipt.nextReadRejected = false;
      } catch (e) {
        receipt.nextReadRejected = true;
        receipt.abortErrorName = e.name;
      }
      await reader.cancel().catch(() => {});
    }
  } finally {
    clearTimeout(timeout);
  }
} catch (error) {
  receipt.failed = true;
  receipt.errorName = error.name;
  receipt.status = error.status ?? null;
} finally {
  linked?.dispose();
  oxy.dispose();
  receipt.finishedAt = new Date().toISOString();
  await fs.writeFile(`${directory}/${receiptPrefix}-receipt.json`, JSON.stringify(receipt), {
    mode: 0o600,
    flag: 'wx',
  });
  console.log(JSON.stringify(receipt));
}
