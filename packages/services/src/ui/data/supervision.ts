/**
 * Supervision (parental controls): the signed-in personal account's
 * supervision state, and what the supervision screen reads beside it (a
 * child's contacts, purchase approvals, the people they name). Each is an
 * answer (`data/answer.ts`) keyed by the account and session it was read for.
 *
 * Advisory UI state only: the server enforces supervision on every request.
 * Everything but the state is read fresh each time a screen shows it, never
 * retried, and dropped once no screen shows it.
 */
import type { OxyServices } from '@oxy.so/core';
import type { SafetyPerson } from '@oxy.so/contracts';
import { answerSource } from './answer';
import { sdkRead } from './readOptions';

/** The people lookup takes at most this many account ids per request. */
const PEOPLE_PER_REQUEST = 100;

const sessionKey = (accountId: string, sessionId: string) => `${accountId}:${sessionId}`;

/** Read when a screen shows it, never retried, dropped when no screen shows it. */
const screenRead = { ...sdkRead, retry: 0, stale: 0, gcTime: 0 } as const;

/**
 * The session's supervision state. Fresh until the session socket or a return
 * to the foreground says otherwise (`SupervisionStateObserver` refreshes it).
 */
export const supervisionState = answerSource('oxy.supervision.state', {
  ...sdkRead,
  key: (_oxy: OxyServices, accountId: string, sessionId: string) =>
    sessionKey(accountId, sessionId),
  load: (_request, oxy, _accountId, _sessionId) => oxy.safety.supervisionState(),
  stale: Number.POSITIVE_INFINITY,
  // The observer keeps the current session's state; this bounds how long a
  // previous session's outlives it.
  gcTime: 30 * 60_000,
});

/** A child's approved contacts. */
export const supervisionContacts = answerSource('oxy.supervision.contacts', {
  ...screenRead,
  key: (_oxy: OxyServices, accountId: string, sessionId: string, childAccountId: string) =>
    `${sessionKey(accountId, sessionId)}:${childAccountId}`,
  load: (_request, oxy, _accountId, _sessionId, childAccountId) =>
    oxy.safety.contacts(childAccountId),
});

/** One page of the purchases awaiting or past a guardian's approval. */
export const purchaseApprovals = answerSource('oxy.supervision.purchases', {
  ...screenRead,
  key: (_oxy: OxyServices, accountId: string, sessionId: string, cursor: string | undefined) =>
    `${sessionKey(accountId, sessionId)}:${cursor ?? ''}`,
  load: (_request, oxy, _accountId, _sessionId, cursor) => oxy.safety.purchaseApprovals({ cursor }),
});

/** One purchase approval. */
export const purchaseApproval = answerSource('oxy.supervision.purchase', {
  ...screenRead,
  key: (_oxy: OxyServices, accountId: string, sessionId: string, purchaseId: string) =>
    `${sessionKey(accountId, sessionId)}:${purchaseId}`,
  load: (_request, oxy, _accountId, _sessionId, purchaseId) =>
    oxy.safety.purchaseApproval(purchaseId),
});

/** The merchants a purchase names. */
export const purchaseMerchants = answerSource('oxy.supervision.purchase-merchants', {
  ...screenRead,
  key: (
    _oxy: OxyServices,
    accountId: string,
    sessionId: string,
    purchaseId: string,
    merchantAccountIds: readonly string[],
  ) => `${sessionKey(accountId, sessionId)}:${purchaseId}:${merchantAccountIds.join(',')}`,
  load: (_request, oxy, _accountId, _sessionId, _purchaseId, merchantAccountIds) =>
    oxy.safety.people({ accountIds: [...merchantAccountIds] }),
});

/**
 * The people with these account ids, asked for in requests of at most
 * `PEOPLE_PER_REQUEST`. A request that fails leaves its people unnamed; the
 * others still name theirs.
 */
export const supervisionPeople = answerSource('oxy.supervision.people', {
  ...screenRead,
  key: (_oxy: OxyServices, accountId: string, sessionId: string, accountIds: readonly string[]) =>
    `${sessionKey(accountId, sessionId)}:${accountIds.join(',')}`,
  load: async (_request, oxy, _accountId, _sessionId, accountIds): Promise<SafetyPerson[]> => {
    const requests = [];
    for (let offset = 0; offset < accountIds.length; offset += PEOPLE_PER_REQUEST) {
      requests.push(
        oxy.safety.people({ accountIds: accountIds.slice(offset, offset + PEOPLE_PER_REQUEST) }),
      );
    }
    const answers = await Promise.allSettled(requests);
    return answers.flatMap((answer) => (answer.status === 'fulfilled' ? answer.value.items : []));
  },
});

/** People found by an exact handle, to choose a guardian or a contact. */
export const peopleSearch = answerSource('oxy.supervision.people-search', {
  ...screenRead,
  key: (_oxy: OxyServices, accountId: string, query: string) => `${accountId}:${query}`,
  load: (_request, oxy, _accountId, query) => oxy.safety.people({ query }),
});
