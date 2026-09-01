import { canonicalFederationHost, createDomainPolicy, isSameFederationHost } from '../index';
import { createInboundDispatcher, type InboundDispatcherConfig } from '../node/inboundDispatch';
import {
  ActorResolver,
  type ActorResolverConfig,
  type FederatedActorRecordBase,
} from '../node/actorResolver';

/**
 * ONE ANSWER TO "IS THIS THE SAME HOST", PROVEN ON THE WIRE.
 *
 * `canonicalFederationHost` is exported so that a consumer comparing a host
 * against this engine's blocklist — a transparency page, an irreversible content
 * purge — uses the engine's own rule instead of a copy that agrees by
 * inspection. That guarantee is worth exactly as much as the evidence that the
 * exported function and the code the wire actually runs cannot disagree, so the
 * agreement is asserted rather than asserted-about:
 *
 *   - the INBOUND path: `processInboxActivity` parses a verified actor URI and
 *     drops the activity when its host is blocked;
 *   - the OUTBOUND-resolution path: `ActorResolver.fetchRemoteActor` screens the
 *     URI's host before any network I/O;
 *   - and the raw-host path a consumer calls directly, `isBlockedDomain`.
 *
 * Each is driven with the awkward spellings — case, `www.`, a trailing dot, an
 * internationalised host in both punycode and unicode — and its verdict is
 * compared against `isSameFederationHost`. A case where they differ is the bug
 * this export exists to make impossible.
 */

/** The blocked instance every case in this file is compared against. */
const BLOCKED_ENTRY = 'spam.example';

/**
 * The awkward spellings, as an ACTOR URI (what the wire carries) plus the
 * bare-host spelling a blocklist would hold.
 *
 * `expectedBlocked` is written out rather than derived, so the table states the
 * intended behaviour independently of the functions under test; the agreement
 * assertions then check the wire and the exported predicate against it AND
 * against each other.
 */
const CASES: ReadonlyArray<{
  name: string;
  actorUri: string;
  /** The blocklist entry to compare against; the default block entry unless stated. */
  entry?: string;
  expectedBlocked: boolean;
}> = [
  { name: 'exact host', actorUri: 'https://spam.example/users/bob', expectedBlocked: true },
  { name: 'uppercase host', actorUri: 'https://SPAM.EXAMPLE/users/bob', expectedBlocked: true },
  { name: 'www. on the wire', actorUri: 'https://www.spam.example/users/bob', expectedBlocked: true },
  {
    name: 'www. on the blocklist entry, bare on the wire',
    actorUri: 'https://spam.example/users/bob',
    entry: 'www.spam.example',
    expectedBlocked: true,
  },
  {
    name: 'whitespace around the blocklist entry',
    actorUri: 'https://spam.example/users/bob',
    entry: '  Spam.Example  ',
    expectedBlocked: true,
  },
  {
    // The fully-qualified spelling is a DIFFERENT string here and on the wire
    // alike — `new URL('https://spam.example./x').hostname` keeps the dot — so a
    // blocklist entry without one does not match it. Widening that is a policy
    // decision, not a canonicalisation one; what matters for this file is that
    // the exported rule and the engine reach the same verdict.
    name: 'trailing dot on the wire (not matched by a dot-less entry)',
    actorUri: 'https://spam.example./users/bob',
    expectedBlocked: false,
  },
  {
    name: 'internationalised host, entry written in punycode',
    actorUri: 'https://xn--ber-goa.example/users/bob',
    entry: 'xn--ber-goa.example',
    expectedBlocked: true,
  },
  {
    // The URL parser applies IDNA ToASCII, so the wire host is punycode; an entry
    // typed in unicode is a different string and matches nothing.
    name: 'internationalised host, entry written in unicode',
    actorUri: 'https://über.example/users/bob',
    entry: 'über.example',
    expectedBlocked: false,
  },
  { name: 'unrelated host', actorUri: 'https://mastodon.social/users/alice', expectedBlocked: false },
  {
    name: 'blocked host as a subdomain prefix',
    actorUri: 'https://spam.example.evil.test/users/bob',
    expectedBlocked: false,
  },
  {
    name: 'blocked host as a suffix',
    actorUri: 'https://notspam.example/users/bob',
    expectedBlocked: false,
  },
];

/** The host the engine screens, extracted exactly as every wire path extracts it. */
function wireHost(actorUri: string): string {
  return new URL(actorUri).hostname;
}

function entryOf(testCase: (typeof CASES)[number]): string {
  return testCase.entry ?? BLOCKED_ENTRY;
}

function policyFor(entry: string) {
  return createDomainPolicy({ domain: 'mention.earth', blockedDomains: [entry] });
}

// --- the wire paths ----------------------------------------------------------

/**
 * Run one activity through the real inbound dispatcher and report whether the
 * domain gate dropped it. Every collaborator below the gate records instead of
 * acting, so "reached the content handler" is unambiguous.
 */
async function inboundDroppedActivity(actorUri: string, entry: string): Promise<boolean> {
  const contentActivities: string[] = [];
  const config: InboundDispatcherConfig = {
    isBlockedDomain: policyFor(entry).isBlockedDomain,
    validateActivity: () => ({ ok: true, type: 'Create' }),
    identity: {
      resolveUserByUsername: async () => null,
      bridgeFollow: async () => undefined,
      bridgeUnfollow: async () => undefined,
    },
    consent: { isSharingEnabledFromUser: () => true },
    actorResolver: { getOrFetchActor: async () => null },
    follows: {
      upsertInboundAccepted: async () => undefined,
      findInboundFollow: async () => null,
      deleteFollowById: async () => undefined,
      findActorOxyUserId: async () => null,
      markOutboundAcceptedByActivityId: async () => false,
      markOutboundAcceptedAnyPending: async () => false,
      markOutboundRejected: async () => undefined,
    },
    delivery: { sendAccept: async () => undefined },
    onContentActivity: async (_activity, verifiedActorUri) => {
      contentActivities.push(verifiedActorUri);
    },
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
  };

  await createInboundDispatcher(config).processInboxActivity(
    { type: 'Create', id: `${actorUri}/statuses/1`, actor: actorUri },
    actorUri,
  );
  return contentActivities.length === 0;
}

/** A sentinel the actor resolver's transports throw, so a call is unmistakable. */
class TransportReached extends Error {
  constructor() {
    super('transport reached');
    this.name = 'TransportReached';
  }
}

/**
 * Run one actor URI through the real resolver and report whether the domain gate
 * refused it BEFORE any network I/O. Both transports throw on contact, so a
 * recorded call means the gate let the host through.
 */
async function actorFetchRefusedBeforeIo(actorUri: string, entry: string): Promise<boolean> {
  const transportCalls: string[] = [];
  const config: ActorResolverConfig<FederatedActorRecordBase> = {
    federationEnabled: true,
    signedFetch: async (url) => {
      transportCalls.push(url);
      throw new TransportReached();
    },
    fetchWebFinger: async (url) => {
      transportCalls.push(url);
      throw new TransportReached();
    },
    isBlockedDomain: policyFor(entry).isBlockedDomain,
    normalizeFederatedAcct: (acct) => acct?.trim().toLowerCase() || undefined,
    domainFromAcct: (acct) => acct.split('@')[1],
    firstStringUrl: () => undefined,
    store: {
      findActorByUri: async () => null,
      upsertActor: async () => null,
      findActorByPublicKeyId: async () => null,
      setActorOxyUserId: async () => undefined,
      tombstoneActor: async () => null,
    },
    identity: {
      resolveExternalUser: async () => null,
      reportActorGone: async () => 'skipped',
    },
    text: {
      inlineField: (value) => (typeof value === 'string' ? value : ''),
      inlineDisplayName: (raw) => raw,
      sanitizeFieldValue: (html) => html,
      htmlToPlainText: (html) => html,
    },
    logger: { info: () => undefined, warn: () => undefined },
  };

  const actor = await new ActorResolver(config).fetchRemoteActor(actorUri);
  expect(actor).toBeNull();
  return transportCalls.length === 0;
}

// --- the exported rule -------------------------------------------------------

describe('canonicalFederationHost', () => {
  it('trims, lowercases and strips one leading www.', () => {
    expect(canonicalFederationHost('Spam.Example')).toBe('spam.example');
    expect(canonicalFederationHost('  spam.example  ')).toBe('spam.example');
    expect(canonicalFederationHost('WWW.Spam.EXAMPLE')).toBe('spam.example');
    expect(canonicalFederationHost('www.www.spam.example')).toBe('www.spam.example');
  });

  it('leaves a trailing dot, a punycode host and an unrelated host alone', () => {
    expect(canonicalFederationHost('spam.example.')).toBe('spam.example.');
    expect(canonicalFederationHost('XN--BER-GOA.example')).toBe('xn--ber-goa.example');
    expect(canonicalFederationHost('wwwspam.example')).toBe('wwwspam.example');
    expect(canonicalFederationHost('')).toBe('');
  });

  it('does not convert a unicode host to its punycode wire form', () => {
    expect(canonicalFederationHost('ÜBER.example')).toBe('über.example');
    expect(canonicalFederationHost('über.example')).not.toBe(new URL('https://über.example').hostname);
  });
});

describe('isSameFederationHost', () => {
  it('is symmetric across case and the www. prefix', () => {
    expect(isSameFederationHost('spam.example', 'WWW.Spam.EXAMPLE')).toBe(true);
    expect(isSameFederationHost('WWW.Spam.EXAMPLE', 'spam.example')).toBe(true);
    expect(isSameFederationHost('www.spam.example', 'spam.example')).toBe(true);
  });

  it('separates hosts that merely look alike', () => {
    expect(isSameFederationHost('spam.example', 'spam.example.')).toBe(false);
    expect(isSameFederationHost('spam.example', 'notspam.example')).toBe(false);
    expect(isSameFederationHost('spam.example', 'spam.example.evil.test')).toBe(false);
    expect(isSameFederationHost('über.example', 'xn--ber-goa.example')).toBe(false);
  });

  it('treats a blank as naming no host, so it matches nothing — including another blank', () => {
    expect(isSameFederationHost('', '')).toBe(false);
    expect(isSameFederationHost('   ', 'spam.example')).toBe(false);
    expect(isSameFederationHost('spam.example', '')).toBe(false);
  });
});

// --- the agreement -----------------------------------------------------------

describe('the exported rule and the wire agree on every awkward spelling', () => {
  it('covers both verdicts, so agreement cannot be vacuous', () => {
    expect(CASES.some((c) => c.expectedBlocked)).toBe(true);
    expect(CASES.some((c) => !c.expectedBlocked)).toBe(true);
    expect(CASES).toHaveLength(11);
  });

  it.each(CASES)('$name', async (testCase) => {
    const entry = entryOf(testCase);
    const host = wireHost(testCase.actorUri);
    const expected = testCase.expectedBlocked;

    // The exported rule, as a consumer would ask it.
    expect(isSameFederationHost(entry, host)).toBe(expected);

    // The policy, as the engine's own callers ask it.
    expect(policyFor(entry).isBlockedDomain(host)).toBe(expected);

    // The inbound wire path: a dropped activity never reaches the content handler.
    expect(await inboundDroppedActivity(testCase.actorUri, entry)).toBe(expected);

    // The actor-resolution wire path: a refused host causes no network I/O.
    expect(await actorFetchRefusedBeforeIo(testCase.actorUri, entry)).toBe(expected);
  });
});
