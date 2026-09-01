/**
 * Follow Graph Mixin Tests
 *
 * `makeRequest` is stubbed, so what these assert is the CONTRACT this mixin
 * offers the applications above it: which request each method makes, and — the
 * part worth a test rather than a comment — the things it must never send.
 */

import { OxyServices } from '../../OxyServices';

describe('OxyServices.followGraph', () => {
  let oxy: OxyServices;
  let makeRequest: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    oxy.httpService.setTokens('test-token');
    makeRequest = jest.spyOn(oxy, 'makeRequest').mockResolvedValue({} as never);
  });

  afterEach(() => {
    makeRequest.mockRestore();
  });

  describe('the identities the client must not be able to state', () => {
    it('never sends a follower id', async () => {
      await oxy.followTarget('target-1');
      await oxy.unfollowTarget('rel-1');
      await oxy.listFollows();

      // A client that could name the follower could forge a follow on somebody
      // else's behalf. The server derives it from the session; there must be no
      // parameter here that even looks like an alternative.
      for (const call of makeRequest.mock.calls) {
        expect(JSON.stringify(call)).not.toMatch(/user_?[Ii]d|follower/);
      }
    });

    it('sends no application id unless the caller explicitly names another app', async () => {
      await oxy.setFollowApplicationMode('rel-1', 'disabled');

      // The ordinary case is "this application", derived server-side. Sending an
      // id here by default would make every app's own writes indistinguishable
      // from one app acting on another's behalf, which is the privileged
      // operation.
      expect(makeRequest.mock.calls[0][2]).toEqual({ mode: 'disabled' });
    });

    it('passes an explicitly named application through, for the privileged path', async () => {
      await oxy.setFollowApplicationMode('rel-1', 'enabled', 'app-9');
      expect(makeRequest.mock.calls[0][2]).toEqual({ mode: 'enabled', applicationId: 'app-9' });

      await oxy.restoreFollowInheritance('rel-1', 'app-9');
      expect(makeRequest.mock.calls[1][1]).toContain('applicationId=app-9');
    });
  });

  describe('request shapes', () => {
    it('follows with PUT and no body when the follow is permanent', async () => {
      await oxy.followTarget('target-1');
      const [method, path, body] = makeRequest.mock.calls[0];
      expect(method).toBe('PUT');
      expect(path).toBe('/v2/follows/target-1');
      expect(body).toEqual({});
    });

    it('carries expiresIn for a timed follow', async () => {
      await oxy.followTarget('target-1', { expiresIn: 72 * 60 * 60 });
      expect(makeRequest.mock.calls[0][2]).toEqual({ expiresIn: 259200 });
    });

    it('unfollows by relationship id, not by target', async () => {
      // The relationship is the thing that exists; addressing the unfollow by
      // target would make the server re-derive which relationship was meant,
      // and get it wrong for any target a user can follow more than one way.
      await oxy.unfollowTarget('rel-1');
      expect(makeRequest.mock.calls[0].slice(0, 2)).toEqual(['DELETE', '/v2/follows/rel-1']);
    });

    it('reads status per target', async () => {
      await oxy.getFollowTargetStatus('target-1');
      expect(makeRequest.mock.calls[0].slice(0, 2)).toEqual([
        'GET',
        '/v2/follows/target-1/status',
      ]);
    });

    it('restores inheritance with no query string when the app means itself', async () => {
      await oxy.restoreFollowInheritance('rel-1');
      expect(makeRequest.mock.calls[0][1]).toBe('/v2/follows/rel-1/context');
    });

    it('paginates by cursor and filters by kind', async () => {
      await oxy.listFollows({ kind: 'oxy.topic', cursor: '2026-01-01T00:00:00.000Z', limit: 20 });
      const path = makeRequest.mock.calls[0][1] as string;
      expect(path).toContain('kind=oxy.topic');
      expect(path).toContain('limit=20');
      expect(path).toContain('cursor=');
      // Never an offset: the list changes while it is read, and an offset skips
      // or repeats rows exactly when it does.
      expect(path).not.toContain('offset');
    });

    it('escapes an id rather than letting it change the path', async () => {
      await oxy.followTarget('../../admin');
      expect(makeRequest.mock.calls[0][1]).toBe('/v2/follows/..%2F..%2Fadmin');
    });

    it('claims a namespace with POST', async () => {
      await oxy.claimFollowNamespace('mention');
      expect(makeRequest.mock.calls[0].slice(0, 3)).toEqual([
        'POST',
        '/v2/follow-targets/namespaces',
        { namespace: 'mention' },
      ]);
    });

    it('releases a namespace with DELETE and encodes the segment', async () => {
      await oxy.releaseFollowNamespace('mention.dev');
      expect(makeRequest.mock.calls[0].slice(0, 2)).toEqual([
        'DELETE',
        '/v2/follow-targets/namespaces/mention.dev',
      ]);
    });
  });

  describe('caching', () => {
    it('caches nothing', async () => {
      await oxy.followTarget('t');
      await oxy.getFollowTargetStatus('t');
      await oxy.listFollows();
      await oxy.unfollowTarget('r');
      await oxy.setFollowApplicationMode('r', 'disabled');
      await oxy.restoreFollowInheritance('r');
      await oxy.claimFollowNamespace('ns');
      await oxy.releaseFollowNamespace('ns');

      // A status cached across a write is the "follow reverts after navigating
      // away and back" bug the legacy path had to fix with explicit
      // invalidation. Not caching here leaves the app's own store as the single
      // cache authority.
      for (const call of makeRequest.mock.calls) {
        expect(call[3]).toEqual({ cache: false });
      }
    });
  });
});
