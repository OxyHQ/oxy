import { QueryClient } from '@tanstack/react-query';
import { HttpService } from '../../../core/src/HttpService';
import { ExperimentalContextBarrier } from '../../../core/src/session/experimentalContextBarrier';
import { accountQueryOwnership } from '../../src/ui/hooks/accountQueryPersistence';

it('removes only owner queries while closed and preserves paused mutations across actors of one subject', async () => {
  const queryClient = new QueryClient();
  const http = new HttpService({ baseURL: 'https://oxy.invalid' });
  http.setTokens('old');
  let actor = 'alice';
  const credential = { deviceId: 'd1', deviceSecret: 'secret' };
  const binding = () => ({
    version: 1,
    deviceId: 'd1',
    deviceSessionId: 'instance',
    revision: actor === 'alice' ? 1 : 2,
    contextId: `ctx-${actor}`,
    actorId: actor,
    accountId: 'org',
    sessionId: `s-${actor}`,
    accessToken: `token-${actor}`,
    expiresAt: '2099-01-01T00:00:00Z',
  });
  const state = () => ({
    deviceId: 'd1',
    revision: binding().revision,
    updatedAt: 1,
    activeAccountId: 'org',
    accounts: [
      { accountId: 'org', sessionId: 's-alice', authuser: 0, operatedByUserId: 'alice' },
      { accountId: 'org', sessionId: 's-nate', authuser: 1, operatedByUserId: 'nate' },
    ],
  });
  const directory = () => ({
    deviceId: 'd1',
    revision: binding().revision,
    updatedAt: 1,
    activeContextId: `ctx-${actor}`,
    principals: [
      {
        id: `p-${actor}`,
        userId: actor,
        authuser: 0,
        user: { id: actor, username: actor },
        contexts: [
          {
            id: `ctx-${actor}`,
            accountId: 'org',
            kind: 'organization',
            relationship: 'member',
            account: { id: 'org', username: 'org' },
            onDevice: true,
            available: true,
            active: true,
            lastUsedAt: null,
          },
        ],
      },
    ],
  });
  const ownership = accountQueryOwnership({ roots: ['private'], mutationKeys: [['owned-queue']] });
  const events: Array<{ snapshot: unknown; token: string | null }> = [];
  const gate = new ExperimentalContextBarrier({
    getCredential: () => credential,
    getAccessToken: () => http.experimentalPeekAccessToken(),
    setAccessToken: (token) => http.experimentalInstallContextToken(token),
    mint: async () => binding(),
    readState: async () => state(),
    readDirectory: async () => directory(),
    prepareCommit: (previous, next) => {
      if (previous && previous.sessionId !== next.sessionId)
        queryClient.removeQueries({ predicate: ownership.ownsQuery });
    },
  });
  http.experimentalSetContextGateProvider(() => gate);
  try {
    expect(await gate.reconcile()).toBe(true);
    queryClient.setQueryData(['private', 'inbox'], { owner: 'alice' });
    queryClient.setQueryData(['shared', 'settings'], { shared: true });
    const mutations = queryClient.getMutationCache();
    const paused = {
      context: undefined,
      data: undefined,
      error: null,
      failureCount: 0,
      failureReason: null,
      isPaused: true,
      status: 'pending' as const,
      variables: undefined,
      submittedAt: 1,
    };
    const replayActors: string[] = [];
    const owned = mutations.build(
      queryClient,
      { mutationKey: ['owned-queue'], mutationFn: async () => undefined },
      paused,
    );
    const other = mutations.build(
      queryClient,
      {
        mutationKey: ['other-queue'],
        mutationFn: async () => {
          replayActors.push(actor);
        },
      },
      paused,
    );
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'removed')
        events.push({ snapshot: gate.snapshot(), token: http.getAccessToken() });
    });
    actor = 'nate';
    expect(await gate.reconcile()).toBe(true);
    expect(events).toEqual([{ snapshot: null, token: null }]);
    expect(queryClient.getQueryData(['private', 'inbox'])).toBeUndefined();
    expect(queryClient.getQueryData(['shared', 'settings'])).toEqual({ shared: true });
    expect(mutations.getAll()).toEqual(expect.arrayContaining([owned, other]));
    expect(owned.state.isPaused).toBe(true);
    expect(other.state.isPaused).toBe(true);
    expect(gate.snapshot()?.actorId).toBe('nate');
    // Preserving a queued mutation is not sufficient: without owner-aware replay,
    // TanStack can resume work enqueued by Alice while Nate is current.
    await other.continue();
    expect(replayActors).toEqual(['nate']);
    unsubscribe();
  } finally {
    queryClient.clear();
    http.dispose();
  }
});
