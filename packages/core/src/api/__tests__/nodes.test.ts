/**
 * User-Node Mixin tests (self-sovereign identity layer — Fase 5 user nodes).
 *
 * Stubs `makeRequest` so the tests run with no network, then asserts:
 *  - `registerNode` fetches the caller's chain head (uncached), signs a
 *    self-issued v2 `type:'node'` envelope (record `{ endpoint, nodePublicKey,
 *    mode }`, seq=head+1, prev=head id, collection `app.oxy.node`, rkey `self`),
 *    POSTs it to the EXISTING `/identity/records` path, sweeps the node +
 *    `/users/me` GET caches, then returns the freshly-read status. `mode`
 *    defaults to `pull`; an explicit `mode` is forwarded; genesis coords apply
 *    when there is no head. It is NATIVE-ONLY: a signing failure (no on-device
 *    identity) propagates, and no-auth throws before any network. It does NOT
 *    sweep when the POST fails, and throws when the node fails to materialize.
 *  - `getMyNode` shapes the cached GET `/nodes/me` and unwraps `.node` (or null).
 *  - `removeMyNode` DELETEs `/nodes/me`, maps `{success}`→`{revoked}`, and sweeps.
 *  - `provisionManagedVault` POSTs `/nodes/managed`, returns `.node`, and sweeps.
 *  - `notifyNodeIngest` POSTs the URL-encoded hint path and resolves void.
 *
 * The write tests mock `SignatureService.signRecordV2` (asserting the exact
 * record + chain coords) so they isolate the SDK's request shaping from native
 * key storage — mirroring the civic mixin tests.
 */

import type { SignedRecordEnvelope } from '@oxy.so/contracts';
import { OxyServices } from '../../OxyServices';
import { SignatureService } from '../../crypto/signatureService';
import type { UserNodeStatus } from '../nodes';

/** Route `invalidateCache` into per-key / per-prefix mocks (one pair per client). */
const cacheSpyMap = new WeakMap<OxyServices, { keys: jest.Mock; prefixes: jest.Mock }>();
function cacheSpies(client: OxyServices): { keys: jest.Mock; prefixes: jest.Mock } {
  let spies = cacheSpyMap.get(client);
  if (!spies) {
    const created = { keys: jest.fn(), prefixes: jest.fn() };
    jest.spyOn(client.http, 'invalidateCache').mockImplementation(({ keys = [], prefixes = [] }) => {
      for (const key of keys) created.keys(key);
      for (const prefix of prefixes) created.prefixes(prefix);
      return 0;
    });
    cacheSpyMap.set(client, created);
    spies = created;
  }
  return spies;
}

const NODE_PUBLIC_KEY = `04${'ab'.repeat(63)}`; // 128 hex chars (uncompressed secp256k1)

const sampleNode: UserNodeStatus = {
  endpoint: 'https://node.example.com',
  nodePublicKey: NODE_PUBLIC_KEY,
  mode: 'pull',
  managed: false,
  controller: 'self',
  status: 'active',
  createdAt: '2026-06-27T00:00:00.000Z',
  updatedAt: '2026-06-27T00:00:00.000Z',
};

describe('oxy.nodes', () => {
  let oxy: OxyServices;
  let makeRequestSpy: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequestSpy = jest.spyOn(oxy, 'request');
    jest.spyOn(oxy.session, 'userId', 'get').mockReturnValue('user-123');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('registerNode', () => {
    const signedEnvelope: SignedRecordEnvelope = {
      version: 2,
      type: 'node',
      subject: 'did:web:oxy.so:u:user-123',
      issuer: 'did:web:oxy.so:u:user-123',
      record: { endpoint: 'https://node.example.com', nodePublicKey: NODE_PUBLIC_KEY, mode: 'pull' },
      issuedAt: 1700000000000,
      seq: 4,
      prev: 'rec-3',
      collection: 'app.oxy.node',
      rkey: 'self',
      publicKey: 'pub',
      alg: 'ES256K-DER-SHA256',
      signature: 'sig',
    };

    it('signs a v2 node record on the caller chain, POSTs /identity/records, sweeps, and returns the status', async () => {
      const signV2Spy = jest.spyOn(SignatureService, 'signRecordV2').mockResolvedValue(signedEnvelope);
      const sweepSpy = cacheSpies(oxy).prefixes;
      // 1st makeRequest = chain head; 2nd = POST /identity/records; 3rd = GET /nodes/me.
      makeRequestSpy
        .mockResolvedValueOnce({ headRecordId: 'rec-3', seq: 3, recordCount: 4 })
        .mockResolvedValueOnce({ envelope: signedEnvelope, verified: true })
        .mockResolvedValueOnce({ node: sampleNode });

      const result = await oxy.nodes.register({
        endpoint: 'https://node.example.com',
        nodePublicKey: NODE_PUBLIC_KEY,
        mode: 'pull',
      });

      // Fetched the caller's chain head first (uncached).
      expect(makeRequestSpy).toHaveBeenNthCalledWith(
        1,
        'GET',
        '/identity/records/user-123/chain/head',
        undefined,
        expect.objectContaining({ cache: false }),
      );
      // Signed a self-issued v2 `node` record: subject=caller DID, exact record,
      // seq=head+1, prev=head id, collection app.oxy.node, rkey self.
      expect(signV2Spy).toHaveBeenCalledWith(
        'node',
        'did:web:oxy.so:u:user-123',
        { endpoint: 'https://node.example.com', nodePublicKey: NODE_PUBLIC_KEY, mode: 'pull' },
        { seq: 4, prev: 'rec-3', collection: 'app.oxy.node', rkey: 'self' },
      );
      // Published via the EXISTING /identity/records path (NOT a bespoke endpoint).
      expect(makeRequestSpy).toHaveBeenNthCalledWith(
        2,
        'POST',
        '/identity/records',
        signedEnvelope,
        expect.objectContaining({ cache: false }),
      );
      // Re-read the freshly-materialized status (cached GET /nodes/me).
      expect(makeRequestSpy).toHaveBeenNthCalledWith(
        3,
        'GET',
        '/nodes/me',
        undefined,
        expect.objectContaining({ cache: true }),
      );
      // Swept the node + /users/me GET caches after the publish.
      expect(sweepSpy).toHaveBeenCalledWith('GET:/nodes/');
      expect(sweepSpy).toHaveBeenCalledWith('GET:/users/me');
      expect(result).toEqual(sampleNode);
    });

    it('forwards an explicit push mode in the signed record', async () => {
      const signV2Spy = jest
        .spyOn(SignatureService, 'signRecordV2')
        .mockResolvedValue(signedEnvelope);
      cacheSpies(oxy).prefixes;
      makeRequestSpy
        .mockResolvedValueOnce({ headRecordId: 'rec-3', seq: 3, recordCount: 4 })
        .mockResolvedValueOnce({ envelope: signedEnvelope, verified: true })
        .mockResolvedValueOnce({ node: sampleNode });

      await oxy.nodes.register({
        endpoint: 'https://node.example.com',
        nodePublicKey: NODE_PUBLIC_KEY,
        mode: 'push',
      });

      expect(signV2Spy).toHaveBeenCalledWith(
        'node',
        'did:web:oxy.so:u:user-123',
        { endpoint: 'https://node.example.com', nodePublicKey: NODE_PUBLIC_KEY, mode: 'push' },
        { seq: 4, prev: 'rec-3', collection: 'app.oxy.node', rkey: 'self' },
      );
    });

    it('defaults mode to pull and uses genesis coords when there is no chain head', async () => {
      const signV2Spy = jest
        .spyOn(SignatureService, 'signRecordV2')
        .mockResolvedValue(signedEnvelope);
      cacheSpies(oxy).prefixes;
      makeRequestSpy
        .mockResolvedValueOnce({ headRecordId: null, seq: -1, recordCount: 0 })
        .mockResolvedValueOnce({ envelope: signedEnvelope, verified: true })
        .mockResolvedValueOnce({ node: sampleNode });

      await oxy.nodes.register({
        endpoint: 'https://node.example.com',
        nodePublicKey: NODE_PUBLIC_KEY,
      });

      expect(signV2Spy).toHaveBeenCalledWith(
        'node',
        'did:web:oxy.so:u:user-123',
        { endpoint: 'https://node.example.com', nodePublicKey: NODE_PUBLIC_KEY, mode: 'pull' },
        { seq: 0, prev: null, collection: 'app.oxy.node', rkey: 'self' },
      );
    });

    it('throws when no user is authenticated (before any network)', async () => {
      jest.spyOn(oxy.session, 'userId', 'get').mockReturnValue(null);
      const signV2Spy = jest.spyOn(SignatureService, 'signRecordV2');

      await expect(
        oxy.nodes.register({ endpoint: 'https://node.example.com', nodePublicKey: NODE_PUBLIC_KEY }),
      ).rejects.toThrow(/No authenticated user/);
      expect(makeRequestSpy).not.toHaveBeenCalled();
      expect(signV2Spy).not.toHaveBeenCalled();
    });

    it('propagates a signing failure (native-only: no on-device identity)', async () => {
      const signV2Spy = jest
        .spyOn(SignatureService, 'signRecordV2')
        .mockRejectedValue(new Error('No identity found. Please create or import an identity first.'));
      const sweepSpy = cacheSpies(oxy).prefixes;
      makeRequestSpy.mockResolvedValueOnce({ headRecordId: 'rec-3', seq: 3, recordCount: 4 });

      await expect(
        oxy.nodes.register({ endpoint: 'https://node.example.com', nodePublicKey: NODE_PUBLIC_KEY }),
      ).rejects.toThrow(/No identity found/);
      // Only the chain-head read happened; no publish, no sweep.
      expect(signV2Spy).toHaveBeenCalledTimes(1);
      expect(makeRequestSpy).toHaveBeenCalledTimes(1);
      expect(sweepSpy).not.toHaveBeenCalled();
    });

    it('does NOT sweep caches when the publish POST fails', async () => {
      jest.spyOn(SignatureService, 'signRecordV2').mockResolvedValue(signedEnvelope);
      const sweepSpy = cacheSpies(oxy).prefixes;
      makeRequestSpy
        .mockResolvedValueOnce({ headRecordId: 'rec-3', seq: 3, recordCount: 4 })
        .mockRejectedValueOnce(new Error('Signed record rejected: chain_fork'));

      await expect(
        oxy.nodes.register({ endpoint: 'https://node.example.com', nodePublicKey: NODE_PUBLIC_KEY }),
      ).rejects.toThrow();
      expect(sweepSpy).not.toHaveBeenCalled();
    });

    it('throws when the node was stored on the chain but not materialized', async () => {
      jest.spyOn(SignatureService, 'signRecordV2').mockResolvedValue(signedEnvelope);
      cacheSpies(oxy).prefixes;
      makeRequestSpy
        .mockResolvedValueOnce({ headRecordId: 'rec-3', seq: 3, recordCount: 4 })
        .mockResolvedValueOnce({ envelope: signedEnvelope, verified: true })
        .mockResolvedValueOnce({ node: null });

      await expect(
        oxy.nodes.register({ endpoint: 'https://node.example.com', nodePublicKey: NODE_PUBLIC_KEY }),
      ).rejects.toThrow(/could not be materialized/);
    });
  });

  describe('getMyNode', () => {
    it('GETs /nodes/me (cached) and unwraps the node', async () => {
      makeRequestSpy.mockResolvedValue({ node: sampleNode });

      const result = await oxy.nodes.mine();

      expect(result).toEqual(sampleNode);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'GET',
        '/nodes/me',
        undefined,
        expect.objectContaining({ cache: true }),
      );
    });

    it('returns null when the caller has no node', async () => {
      makeRequestSpy.mockResolvedValue({ node: null });
      await expect(oxy.nodes.mine()).resolves.toBeNull();
    });

    it('rejects on a transport failure', async () => {
      makeRequestSpy.mockRejectedValue(new Error('network down'));
      await expect(oxy.nodes.mine()).rejects.toThrow();
    });
  });

  describe('removeMyNode', () => {
    it('DELETEs /nodes/me, maps success→revoked, and sweeps caches', async () => {
      const sweepSpy = cacheSpies(oxy).prefixes;
      makeRequestSpy.mockResolvedValue({ success: true });

      const result = await oxy.nodes.removeMine();

      expect(result).toEqual({ revoked: true });
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'DELETE',
        '/nodes/me',
        undefined,
        expect.objectContaining({ cache: false }),
      );
      expect(sweepSpy).toHaveBeenCalledWith('GET:/nodes/');
      expect(sweepSpy).toHaveBeenCalledWith('GET:/users/me');
    });

    it('does NOT sweep caches when the DELETE fails', async () => {
      const sweepSpy = cacheSpies(oxy).prefixes;
      makeRequestSpy.mockRejectedValue(new Error('No active node registration to revoke'));

      await expect(oxy.nodes.removeMine()).rejects.toThrow();
      expect(sweepSpy).not.toHaveBeenCalled();
    });
  });

  describe('provisionManagedVault', () => {
    it('POSTs /nodes/managed, returns the node, and sweeps caches', async () => {
      const managedNode: UserNodeStatus = {
        ...sampleNode,
        managed: true,
        controller: 'oxy',
      };
      const sweepSpy = cacheSpies(oxy).prefixes;
      makeRequestSpy.mockResolvedValue({ node: managedNode });

      const result = await oxy.nodes.provisionManagedVault();

      expect(result).toEqual(managedNode);
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/nodes/managed',
        undefined,
        expect.objectContaining({ cache: false }),
      );
      expect(sweepSpy).toHaveBeenCalledWith('GET:/nodes/');
      expect(sweepSpy).toHaveBeenCalledWith('GET:/users/me');
    });

    it('does NOT sweep caches when provisioning fails', async () => {
      const sweepSpy = cacheSpies(oxy).prefixes;
      makeRequestSpy.mockRejectedValue(new Error('Managed vaults are not available right now'));

      await expect(oxy.nodes.provisionManagedVault()).rejects.toThrow();
      expect(sweepSpy).not.toHaveBeenCalled();
    });
  });

  describe('notifyNodeIngest', () => {
    it('POSTs the ingest-notify hint and resolves void', async () => {
      makeRequestSpy.mockResolvedValue({ accepted: true });

      await expect(oxy.nodes.notifyIngest('user-9')).resolves.toBeUndefined();
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/nodes/ingest/notify/user-9',
        undefined,
        expect.objectContaining({ cache: false }),
      );
    });

    it('URL-encodes the userId path segment', async () => {
      makeRequestSpy.mockResolvedValue({ accepted: true });
      await oxy.nodes.notifyIngest('a/b');
      expect(makeRequestSpy).toHaveBeenCalledWith(
        'POST',
        '/nodes/ingest/notify/a%2Fb',
        undefined,
        expect.anything(),
      );
    });

    it('rejects on a transport failure', async () => {
      makeRequestSpy.mockRejectedValue(new Error('network down'));
      await expect(oxy.nodes.notifyIngest('user-9')).rejects.toThrow();
    });
  });
});
