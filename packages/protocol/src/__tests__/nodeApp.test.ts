/**
 * `createNodeApp` handler tests — supertest over the generic Express factory,
 * driven by the in-memory `RecordStore`/`BlobStore` harness + an owner-key
 * `OwnerAuth`. Covers the well-known manifest, owner-authenticated record writes
 * (happy path, chaining, wrong-signer + malformed + gap rejection), the
 * collection allowlist, the batch push, the log cursor/cap, and the blob
 * pin/serve path with signed-header auth + hash validation.
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import request from 'supertest';
import { createNodeApp, type NodeAppConfig } from '../node/nodeApp';
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

function makeConfig(
  nodePublicKey: string,
  collections: readonly string[] = [],
  writeRateLimit?: { windowMs: number; max: number; maxEntries?: number },
): NodeAppConfig {
  return {
    wellKnownPath: '/.well-known/oxy-node.json',
    protocolId: 'oxy-node/1',
    serviceType: 'OxyPersonalDataNode',
    mode: 'self-hosted',
    nodePublicKey,
    maxBlobBytes: 25 * 1024 * 1024,
    collections,
    writeRateLimit,
  };
}

// Apps built during a test own a background rate-limiter sweep timer; track them
// so `afterEach` can stop the timers and leave no open handles between tests.
const builtApps: Array<ReturnType<typeof createNodeApp>> = [];

function buildApp(
  owner: TestKeyPair,
  collections: readonly string[] = [],
  writeRateLimit?: { windowMs: number; max: number; maxEntries?: number },
) {
  const store = createInMemoryNodeStore();
  const app = createNodeApp({
    store,
    config: makeConfig(owner.publicKey, collections, writeRateLimit),
    ownerAuth: createTestOwnerAuth(owner.publicKey),
    logger: silentLogger,
  });
  builtApps.push(app);
  return { app, store };
}

describe('createNodeApp', () => {
  let owner: TestKeyPair;

  beforeEach(() => {
    owner = generateKeyPair();
  });

  afterEach(() => {
    for (const app of builtApps.splice(0)) {
      app.stop();
    }
  });

  it('GET /.well-known/oxy-node.json returns identity + liveness (incl. serviceType)', async () => {
    const { app } = buildApp(owner);
    const res = await request(app).get('/.well-known/oxy-node.json');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      nodePublicKey: owner.publicKey,
      mode: 'self-hosted',
      version: 'oxy-node/1',
      serviceType: 'OxyPersonalDataNode',
      head: null,
    });
  });

  it('GET /oxy/head reports an empty chain then advances after a write', async () => {
    const { app } = buildApp(owner);
    const empty = await request(app).get('/oxy/head');
    expect(empty.body).toEqual({ seq: null, headRecordId: null, recordCount: 0 });

    const envelope = await buildSignedEnvelope({ privateKey: owner.privateKey, seq: 0, prev: null });
    const recordId = await computeRecordId(envelope);
    const write = await request(app).post('/records').send(envelope);
    expect(write.status).toBe(201);
    expect(write.body).toEqual({ recordId, seq: 0 });

    const head = await request(app).get('/oxy/head');
    expect(head.body).toEqual({ seq: 0, headRecordId: recordId, recordCount: 1 });
  });

  it('POST /records accepts an owner-signed envelope and chains the next one', async () => {
    const { app } = buildApp(owner);
    const genesis = await buildSignedEnvelope({ privateKey: owner.privateKey, seq: 0, prev: null });
    const genesisId = await computeRecordId(genesis);
    await request(app).post('/records').send(genesis).expect(201);

    const second = await buildSignedEnvelope({ privateKey: owner.privateKey, seq: 1, prev: genesisId, record: { step: 2 } });
    const secondId = await computeRecordId(second);
    const res = await request(app).post('/records').send(second);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ recordId: secondId, seq: 1 });
  });

  it('POST /records rejects a record signed by a NON-owner key (403 not_owner)', async () => {
    const { app } = buildApp(owner);
    const attacker = generateKeyPair();
    const envelope = await buildSignedEnvelope({ privateKey: attacker.privateKey, seq: 0, prev: null });
    const res = await request(app).post('/records').send(envelope);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'not_owner' });
  });

  it('POST /records rejects a malformed envelope (400 invalid_envelope)', async () => {
    const { app } = buildApp(owner);
    const res = await request(app).post('/records').send({ not: 'an envelope' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_envelope' });
  });

  it('POST /records rejects a chain gap (422 chain_gap)', async () => {
    const { app } = buildApp(owner);
    const envelope = await buildSignedEnvelope({ privateKey: owner.privateKey, seq: 3, prev: null });
    const res = await request(app).post('/records').send(envelope);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'chain_gap' });
  });

  it('POST /records rejects a foreign collection when an allowlist is set (403)', async () => {
    const { app } = buildApp(owner, ['app.mention.feed.post']);
    const inAllow = await buildSignedEnvelope({
      privateKey: owner.privateKey,
      seq: 0,
      prev: null,
      collection: 'app.mention.feed.post',
    });
    await request(app).post('/records').send(inAllow).expect(201);

    const foreign = await buildSignedEnvelope({
      privateKey: owner.privateKey,
      seq: 1,
      prev: await computeRecordId(inAllow),
      collection: 'app.oxy.identity',
    });
    const res = await request(app).post('/records').send(foreign);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'foreign_collection' });
  });

  it('POST /sync/push verifies + appends a batch in order', async () => {
    const { app } = buildApp(owner);
    const genesis = await buildSignedEnvelope({ privateKey: owner.privateKey, seq: 0, prev: null });
    const second = await buildSignedEnvelope({ privateKey: owner.privateKey, seq: 1, prev: await computeRecordId(genesis) });
    const res = await request(app).post('/sync/push').send({ records: [genesis, second] });
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(2);
    expect(res.body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
  });

  it('GET /oxy/log returns the ordered log from a cursor and caps the limit', async () => {
    const { app } = buildApp(owner);
    let prev: string | null = null;
    const ids: string[] = [];
    for (let seq = 0; seq < 4; seq += 1) {
      const envelope = await buildSignedEnvelope({ privateKey: owner.privateKey, seq, prev, record: { seq } });
      const id = await computeRecordId(envelope);
      await request(app).post('/records').send(envelope).expect(201);
      ids.push(id);
      prev = id;
    }

    const full = await request(app).get('/oxy/log');
    expect(full.body.count).toBe(4);
    expect(full.body.records.map((entry: { seq: number }) => entry.seq)).toEqual([0, 1, 2, 3]);
    expect(full.body.records[0].recordId).toBe(ids[0]);
    expect(full.body.head).toEqual({ seq: 3, headRecordId: ids[3] });

    const capped = await request(app).get('/oxy/log').query({ limit: 2 });
    expect(capped.body.records.map((entry: { seq: number }) => entry.seq)).toEqual([0, 1]);

    const sinceCursor = await request(app).get('/oxy/log').query({ since: ids[1] });
    expect(sinceCursor.body.records.map((entry: { seq: number }) => entry.seq)).toEqual([2, 3]);

    const unknownCursor = await request(app).get('/oxy/log').query({ since: 'f'.repeat(64) });
    expect(unknownCursor.body.records).toEqual([]);
  });

  it('PUT then GET a blob with owner auth + hash validation', async () => {
    const { app } = buildApp(owner);
    const bytes = Buffer.from('a pinned media blob');
    const hash = createHash('sha256').update(bytes).digest('hex');

    const auth = await signBlobPin(hash, owner);
    const put = await request(app)
      .put(`/blobs/${hash}`)
      .set({
        'x-oxy-node-public-key': auth.publicKey,
        'x-oxy-node-signature': auth.signature,
        'x-oxy-node-timestamp': String(auth.timestamp),
      })
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
    const { app } = buildApp(owner);
    const hash = createHash('sha256').update(Buffer.from('nope')).digest('hex');
    const res = await request(app).get(`/blobs/${hash}`);
    expect(res.status).toBe(404);
  });

  it('PUT /blobs/:hash rejects bytes that do not hash to the address (400 hash_mismatch)', async () => {
    const { app } = buildApp(owner);
    const realBytes = Buffer.from('the actual bytes');
    const claimedHash = createHash('sha256').update(Buffer.from('some other bytes')).digest('hex');

    const auth = await signBlobPin(claimedHash, owner);
    const res = await request(app)
      .put(`/blobs/${claimedHash}`)
      .set({
        'x-oxy-node-public-key': auth.publicKey,
        'x-oxy-node-signature': auth.signature,
        'x-oxy-node-timestamp': String(auth.timestamp),
      })
      .set('Content-Type', 'application/octet-stream')
      .send(realBytes);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'hash_mismatch' });
  });

  it('PUT /blobs/:hash rejects a request with no body framing at all (400 empty_blob)', async () => {
    // `express.raw` assigns `{}` — not an empty Buffer — when the request
    // carries no body framing (`typeis.hasBody(req)` is false), so `.length` on
    // it is `undefined` and an emptiness check alone would let it through to
    // `store.putBlob` and to `size: bytes.length` in the 201 payload. CodeQL
    // flags that `.length` (js/type-confusion-through-parameter-tampering,
    // alert #473) because it does not model `Buffer.isBuffer` as a narrowing
    // guard; this pins the guard that makes the flag a false positive.
    //
    // The request is written onto a raw socket because neither supertest nor
    // `http.request` can express it — both add a `Content-Length` or a
    // `Transfer-Encoding`, either of which makes `hasBody` true and produces an
    // empty Buffer instead, exercising only the other half of the guard.
    const { app, store } = buildApp(owner);
    const bytes = Buffer.from('a blob that never gets sent');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const auth = await signBlobPin(hash, owner);

    const server = createServer(app);
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const { port } = server.address() as AddressInfo;

    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(
          [
            `PUT /blobs/${hash} HTTP/1.1`,
            'Host: 127.0.0.1',
            `x-oxy-node-public-key: ${auth.publicKey}`,
            `x-oxy-node-signature: ${auth.signature}`,
            `x-oxy-node-timestamp: ${auth.timestamp}`,
            'Connection: close',
            '',
            '',
          ].join('\r\n')
        );
      });
      let received = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => { received += chunk; });
      socket.on('error', reject);
      socket.on('end', () => resolve(received));
    });
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

    expect(raw).toContain('HTTP/1.1 400');
    expect(raw).toContain('empty_blob');
    // And nothing was pinned under that address.
    expect(await store.getBlob(hash)).toBeNull();
  });

  it('PUT /blobs/:hash rejects an empty body (400 empty_blob)', async () => {
    const { app, store } = buildApp(owner);
    const bytes = Buffer.from('another blob that never gets sent');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const auth = await signBlobPin(hash, owner);

    const res = await request(app)
      .put(`/blobs/${hash}`)
      .set({
        'x-oxy-node-public-key': auth.publicKey,
        'x-oxy-node-signature': auth.signature,
        'x-oxy-node-timestamp': String(auth.timestamp),
      })
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(0));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'empty_blob' });
    expect(await store.getBlob(hash)).toBeNull();
  });

  it('PUT /blobs/:hash rejects a non-owner signature (403)', async () => {
    const { app } = buildApp(owner);
    const bytes = Buffer.from('blob from an impostor');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const attacker = generateKeyPair();

    const auth = await signBlobPin(hash, attacker);
    const res = await request(app)
      .put(`/blobs/${hash}`)
      .set({
        'x-oxy-node-public-key': auth.publicKey,
        'x-oxy-node-signature': auth.signature,
        'x-oxy-node-timestamp': String(auth.timestamp),
      })
      .set('Content-Type', 'application/octet-stream')
      .send(bytes);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });

  it('PUT /blobs/:hash requires owner-auth headers (401)', async () => {
    const { app } = buildApp(owner);
    const bytes = Buffer.from('unauthenticated');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const res = await request(app)
      .put(`/blobs/${hash}`)
      .set('Content-Type', 'application/octet-stream')
      .send(bytes);
    expect(res.status).toBe(401);
  });

  it('rate-limits the owner write route after the configured budget (429 rate_limited)', async () => {
    // A tiny per-window budget makes the limiter deterministic: the 3rd write
    // within the window is rejected 429 BEFORE the handler runs, regardless of
    // each request's chain outcome.
    const { app } = buildApp(owner, [], { windowMs: 60_000, max: 2 });
    const envelope = await buildSignedEnvelope({ privateKey: owner.privateKey, seq: 0, prev: null });

    const first = await request(app).post('/records').send(envelope);
    expect(first.status).toBe(201);
    // Second consumes the last slot (a chain_conflict on the replayed genesis,
    // but it still counts against the budget — the limiter precedes the handler).
    const second = await request(app).post('/records').send(envelope);
    expect(second.status).not.toBe(429);
    // Third exceeds the budget.
    const third = await request(app).post('/records').send(envelope);
    expect(third.status).toBe(429);
    expect(third.body).toEqual({ error: 'rate_limited' });
  });

  it('GET /oxy/log coerces an array `since` param to its first value (no 500)', async () => {
    const { app } = buildApp(owner);
    let prev: string | null = null;
    const ids: string[] = [];
    for (let seq = 0; seq < 3; seq += 1) {
      const envelope = await buildSignedEnvelope({ privateKey: owner.privateKey, seq, prev, record: { seq } });
      const id = await computeRecordId(envelope);
      await request(app).post('/records').send(envelope).expect(201);
      ids.push(id);
      prev = id;
    }

    // `?since[]=<id1>&since[]=<id2>` arrives as a string[] — the handler must
    // take the FIRST value (a tampered array can never cause type confusion).
    const res = await request(app).get('/oxy/log').query({ 'since[]': [ids[0], ids[2]] });
    expect(res.status).toBe(200);
    // Cursor resolves off ids[0] → records strictly after seq 0 → [1, 2].
    expect(res.body.records.map((entry: { seq: number }) => entry.seq)).toEqual([1, 2]);
  });

  it('GET /oxy/log treats an array `limit` param as its first value', async () => {
    const { app } = buildApp(owner);
    let prev: string | null = null;
    for (let seq = 0; seq < 4; seq += 1) {
      const envelope = await buildSignedEnvelope({ privateKey: owner.privateKey, seq, prev, record: { seq } });
      await request(app).post('/records').send(envelope).expect(201);
      prev = await computeRecordId(envelope);
    }

    const res = await request(app).get('/oxy/log').query({ 'limit[]': ['2', '99'] });
    expect(res.status).toBe(200);
    expect(res.body.records.map((entry: { seq: number }) => entry.seq)).toEqual([0, 1]);
  });
});
