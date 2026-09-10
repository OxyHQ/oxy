/**
 * HTTP API tests (supertest over the in-process Express app + in-memory store).
 *
 * Covers the well-known liveness shape, owner-authenticated record writes
 * (happy path + wrong-signer rejection), the log cursor/cap, the head, and
 * the blob pin/serve path with signed-header owner auth + hash validation.
 */

import { createHash } from 'node:crypto';
import request from 'supertest';
import pino from 'pino';
import { signMessage } from '@oxy.so/protocol';
import {
  DEFAULT_APP_NAMESPACE,
  DEFAULT_SERVICE_TYPE,
  DEFAULT_WELL_KNOWN_PATH,
  OWNER_AUTH_HEADERS,
  PROTOCOL_VERSION,
} from '@oxy.so/protocol/node';
import { createApp } from '../app';
import { NodeStore } from '../store/nodeStore';
import type { NodeConfig } from '../config';
import { buildSignedEnvelope, generateTestKeyPair, recordIdOf, type TestKeyPair } from './helpers/signEnvelope';

function makeConfig(ownerPublicKey: string): NodeConfig {
  return {
    port: 0,
    ownerPublicKey: ownerPublicKey.toLowerCase(),
    nodePublicKey: ownerPublicKey.toLowerCase(),
    nodePrivateKey: null,
    mode: 'self-hosted',
    dataDir: '/tmp/oxy-node-test',
    databasePath: ':memory:',
    maxBlobBytes: 25 * 1024 * 1024,
    protocolId: PROTOCOL_VERSION,
    serviceType: DEFAULT_SERVICE_TYPE,
    wellKnownPath: DEFAULT_WELL_KNOWN_PATH,
    appNamespace: DEFAULT_APP_NAMESPACE,
    collections: [],
    envPrefix: 'OXY_NODE_',
  };
}

/** Build the owner-signed headers authorizing a blob pin. */
async function ownerBlobPinHeaders(owner: TestKeyPair, hash: string): Promise<Record<string, string>> {
  const timestamp = Date.now();
  const signature = await signMessage(`oxy-node:blob-pin:${hash}:${timestamp}`, owner.privateKey);
  return {
    [OWNER_AUTH_HEADERS.publicKey]: owner.publicKey,
    [OWNER_AUTH_HEADERS.signature]: signature,
    [OWNER_AUTH_HEADERS.timestamp]: String(timestamp),
  };
}

describe('node HTTP API', () => {
  let store: NodeStore;
  let owner: TestKeyPair;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = new NodeStore(':memory:');
    owner = generateTestKeyPair();
    app = createApp({ store, config: makeConfig(owner.publicKey), logger: pino({ level: 'silent' }) });
  });

  afterEach(() => {
    app.stop();
    store.close();
  });

  it('GET /.well-known/oxy-node.json returns identity + liveness', async () => {
    const res = await request(app).get('/.well-known/oxy-node.json');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      nodePublicKey: owner.publicKey.toLowerCase(),
      mode: 'self-hosted',
      version: PROTOCOL_VERSION,
      serviceType: DEFAULT_SERVICE_TYPE,
      head: null,
    });
  });

  it('GET /oxy/head reports an empty chain then advances after a write', async () => {
    const empty = await request(app).get('/oxy/head');
    expect(empty.body).toEqual({ seq: null, headRecordId: null, recordCount: 0 });

    const envelope = await buildSignedEnvelope({
      privateKey: owner.privateKey,
      publicKey: owner.publicKey,
      seq: 0,
      prev: null,
    });
    const recordId = await recordIdOf(envelope);
    const write = await request(app).post('/records').send(envelope);
    expect(write.status).toBe(201);
    expect(write.body).toEqual({ recordId, seq: 0 });

    const head = await request(app).get('/oxy/head');
    expect(head.body).toEqual({ seq: 0, headRecordId: recordId, recordCount: 1 });

    const wellKnown = await request(app).get('/.well-known/oxy-node.json');
    expect(wellKnown.body.head).toEqual({ seq: 0, headRecordId: recordId });
  });

  it('POST /records accepts an owner-signed envelope and chains the next one', async () => {
    const genesis = await buildSignedEnvelope({
      privateKey: owner.privateKey,
      publicKey: owner.publicKey,
      seq: 0,
      prev: null,
    });
    const genesisId = await recordIdOf(genesis);
    await request(app).post('/records').send(genesis).expect(201);

    const second = await buildSignedEnvelope({
      privateKey: owner.privateKey,
      publicKey: owner.publicKey,
      seq: 1,
      prev: genesisId,
      record: { step: 2 },
    });
    const secondId = await recordIdOf(second);
    const res = await request(app).post('/records').send(second);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ recordId: secondId, seq: 1 });
  });

  it('POST /records rejects a record signed by a NON-owner key (403)', async () => {
    const attacker = generateTestKeyPair();
    const envelope = await buildSignedEnvelope({
      privateKey: attacker.privateKey,
      publicKey: attacker.publicKey, // a valid self-signature, but not the owner
      seq: 0,
      prev: null,
    });

    const res = await request(app).post('/records').send(envelope);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'not_owner' });
  });

  it('POST /records rejects a malformed envelope (400)', async () => {
    const res = await request(app).post('/records').send({ not: 'an envelope' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_envelope' });
  });

  it('POST /records rejects a chain gap (422)', async () => {
    const envelope = await buildSignedEnvelope({
      privateKey: owner.privateKey,
      publicKey: owner.publicKey,
      seq: 3,
      prev: null,
    });
    const res = await request(app).post('/records').send(envelope);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'chain_gap' });
  });

  it('GET /oxy/log returns the ordered log from a cursor and caps the limit', async () => {
    let prev: string | null = null;
    const ids: string[] = [];
    for (let seq = 0; seq < 4; seq += 1) {
      const envelope = await buildSignedEnvelope({
        privateKey: owner.privateKey,
        publicKey: owner.publicKey,
        seq,
        prev,
        record: { seq },
      });
      const id = await recordIdOf(envelope);
      await request(app).post('/records').send(envelope).expect(201);
      ids.push(id);
      prev = id;
    }

    const full = await request(app).get('/oxy/log');
    expect(full.body.count).toBe(4);
    expect(full.body.records.map((entry: { seq: number }) => entry.seq)).toEqual([0, 1, 2, 3]);
    expect(full.body.head).toEqual({ seq: 3, headRecordId: ids[3] });

    const capped = await request(app).get('/oxy/log').query({ limit: 2 });
    expect(capped.body.records.map((entry: { seq: number }) => entry.seq)).toEqual([0, 1]);

    const sinceCursor = await request(app).get('/oxy/log').query({ since: ids[1] });
    expect(sinceCursor.body.records.map((entry: { seq: number }) => entry.seq)).toEqual([2, 3]);
  });

  it('PUT then GET a blob with owner auth + hash validation', async () => {
    const bytes = Buffer.from('a pinned media blob');
    const hash = createHash('sha256').update(bytes).digest('hex');

    const headers = await ownerBlobPinHeaders(owner, hash);
    const put = await request(app)
      .put(`/blobs/${hash}`)
      .set(headers)
      .set('Content-Type', 'application/octet-stream')
      .send(bytes);
    expect(put.status).toBe(201);
    expect(put.body).toEqual({ hash, size: bytes.length });

    const get = await request(app).get(`/blobs/${hash}`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(get.status).toBe(200);
    expect(Buffer.isBuffer(get.body) ? get.body : Buffer.from(get.body)).toEqual(bytes);
  });

  it('GET /blobs/:hash 404s when absent', async () => {
    const hash = createHash('sha256').update(Buffer.from('nope')).digest('hex');
    const res = await request(app).get(`/blobs/${hash}`);
    expect(res.status).toBe(404);
  });

  it('PUT /blobs/:hash rejects bytes that do not hash to the address (400)', async () => {
    const realBytes = Buffer.from('the actual bytes');
    const claimedHash = createHash('sha256').update(Buffer.from('some other bytes')).digest('hex');

    const headers = await ownerBlobPinHeaders(owner, claimedHash);
    const res = await request(app)
      .put(`/blobs/${claimedHash}`)
      .set(headers)
      .set('Content-Type', 'application/octet-stream')
      .send(realBytes);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'hash_mismatch' });
  });

  it('PUT /blobs/:hash rejects a non-owner signature (403)', async () => {
    const bytes = Buffer.from('blob from an impostor');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const attacker = generateTestKeyPair();

    const headers = await ownerBlobPinHeaders(attacker, hash);
    const res = await request(app)
      .put(`/blobs/${hash}`)
      .set(headers)
      .set('Content-Type', 'application/octet-stream')
      .send(bytes);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });

  it('PUT /blobs/:hash requires owner-auth headers (401)', async () => {
    const bytes = Buffer.from('unauthenticated');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const res = await request(app)
      .put(`/blobs/${hash}`)
      .set('Content-Type', 'application/octet-stream')
      .send(bytes);
    expect(res.status).toBe(401);
  });
});
