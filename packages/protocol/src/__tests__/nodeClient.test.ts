/**
 * `NodeClient` round-trip tests — drive the client against a REAL `createNodeApp`
 * server (booted on an ephemeral port) through a Node `http` transport adapter
 * (the same `NodeFetch` shape oxy-api adapts from `safeFetch`). Locks the
 * head/log/records/blobs surface end-to-end, including the gap/fork rejection
 * reasons surfaced as `NodeClientError` and the blob pin/serve round trip.
 */

import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createNodeApp, type NodeAppConfig } from '../node/nodeApp';
import { NodeClient, NodeClientError, trimTrailingSlashes } from '../node/nodeClient';
import type { NodeFetch } from '../node/httpFetch';
import { computeRecordId } from '../envelope/recordId';
import {
  buildSignedEnvelope,
  createInMemoryNodeStore,
  createTestOwnerAuth,
  generateKeyPair,
  signBlobPin,
  silentLogger,
  type TestKeyPair,
} from './nodeHarness';

/** A Node `http` transport satisfying the injected `NodeFetch` contract. */
const httpFetch: NodeFetch = (url, init) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: init.method,
        headers: init.headers,
      },
      (res) => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: res,
          destroy: () => res.destroy(),
        });
      },
    );
    req.on('error', reject);
    if (init.body) {
      req.write(Buffer.from(init.body));
    }
    req.end();
  });

function makeConfig(nodePublicKey: string): NodeAppConfig {
  return {
    wellKnownPath: '/.well-known/oxy-node.json',
    protocolId: 'oxy-node/1',
    serviceType: 'OxyPersonalDataNode',
    mode: 'self-hosted',
    nodePublicKey,
    maxBlobBytes: 25 * 1024 * 1024,
    collections: [],
  };
}

describe('trimTrailingSlashes', () => {
  it('removes one or many trailing slashes', () => {
    expect(trimTrailingSlashes('https://node.example')).toBe('https://node.example');
    expect(trimTrailingSlashes('https://node.example/')).toBe('https://node.example');
    expect(trimTrailingSlashes('https://node.example////')).toBe('https://node.example');
  });

  it('preserves interior slashes and the empty string', () => {
    expect(trimTrailingSlashes('https://node.example/oxy/log')).toBe(
      'https://node.example/oxy/log',
    );
    expect(trimTrailingSlashes('')).toBe('');
    expect(trimTrailingSlashes('///')).toBe('');
  });

  it('is linear-time on a long all-slash input (no ReDoS backtracking)', () => {
    const pathological = `https://node.example${'/'.repeat(200_000)}`;
    const start = Date.now();
    expect(trimTrailingSlashes(pathological)).toBe('https://node.example');
    // A linear scan of 200k chars completes in well under a tenth of a second;
    // a backtracking regex would be orders of magnitude slower.
    expect(Date.now() - start).toBeLessThan(100);
  });
});

describe('NodeClient (end-to-end against createNodeApp)', () => {
  let owner: TestKeyPair;
  let app: ReturnType<typeof createNodeApp>;
  let server: http.Server;
  let client: NodeClient;

  beforeEach(async () => {
    owner = generateKeyPair();
    app = createNodeApp({
      store: createInMemoryNodeStore(),
      config: makeConfig(owner.publicKey),
      ownerAuth: createTestOwnerAuth(owner.publicKey),
      logger: silentLogger,
    });
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    client = new NodeClient({ baseUrl: `http://127.0.0.1:${port}`, fetch: httpFetch });
  });

  afterEach(async () => {
    app.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('head() reports an empty chain, then advances after writes', async () => {
    expect(await client.head()).toEqual({ seq: null, headRecordId: null, recordCount: 0 });

    const genesis = await buildSignedEnvelope({ privateKey: owner.privateKey, seq: 0, prev: null });
    const genesisId = await computeRecordId(genesis);
    expect(await client.writeRecord(genesis)).toEqual({ recordId: genesisId, seq: 0 });

    expect(await client.head()).toEqual({ seq: 0, headRecordId: genesisId, recordCount: 1 });
  });

  it('writeRecord chains records and log() returns them in order', async () => {
    const genesis = await buildSignedEnvelope({ privateKey: owner.privateKey, seq: 0, prev: null });
    const genesisId = await computeRecordId(genesis);
    await client.writeRecord(genesis);

    const second = await buildSignedEnvelope({
      privateKey: owner.privateKey,
      seq: 1,
      prev: genesisId,
    });
    const secondId = await computeRecordId(second);
    expect(await client.writeRecord(second)).toEqual({ recordId: secondId, seq: 1 });

    const page = await client.log(-1, 100);
    expect(page.count).toBe(2);
    expect(page.records.map((r) => (r as { seq: number }).seq)).toEqual([0, 1]);
    expect((page.records[1] as { recordId: string }).recordId).toBe(secondId);
    expect(page.head).toEqual({ seq: 1, headRecordId: secondId });

    const since = await client.log(0, 100);
    expect(since.records.map((r) => (r as { seq: number }).seq)).toEqual([1]);
  });

  it('writeRecord surfaces a chain gap as a NodeClientError (422 chain_gap)', async () => {
    const gap = await buildSignedEnvelope({ privateKey: owner.privateKey, seq: 3, prev: null });
    await expect(client.writeRecord(gap)).rejects.toMatchObject({
      status: 422,
      reason: 'chain_gap',
    });
    await expect(client.writeRecord(gap)).rejects.toBeInstanceOf(NodeClientError);
  });

  it('writeRecord surfaces a chain fork as a NodeClientError (422 chain_fork)', async () => {
    const genesis = await buildSignedEnvelope({ privateKey: owner.privateKey, seq: 0, prev: null });
    await client.writeRecord(genesis);

    const fork = await buildSignedEnvelope({
      privateKey: owner.privateKey,
      seq: 1,
      prev: 'f'.repeat(64),
    });
    await expect(client.writeRecord(fork)).rejects.toMatchObject({
      status: 422,
      reason: 'chain_fork',
    });
  });

  it('writeRecord surfaces a non-owner write as a NodeClientError (403 not_owner)', async () => {
    const attacker = generateKeyPair();
    const envelope = await buildSignedEnvelope({
      privateKey: attacker.privateKey,
      seq: 0,
      prev: null,
    });
    await expect(client.writeRecord(envelope)).rejects.toMatchObject({
      status: 403,
      reason: 'not_owner',
    });
  });

  it('putBlob then getBlob round-trips; getBlob returns null when absent', async () => {
    const bytes = Buffer.from('client-pinned blob bytes');
    const hash = createHash('sha256').update(bytes).digest('hex');

    expect(await client.getBlob(hash)).toBeNull();

    const auth = await signBlobPin(hash, owner);
    expect(await client.putBlob(hash, bytes, auth)).toEqual({ hash, size: bytes.length });

    const fetched = await client.getBlob(hash);
    expect(fetched).not.toBeNull();
    expect(Buffer.from(fetched as Uint8Array).equals(bytes)).toBe(true);
  });
});
