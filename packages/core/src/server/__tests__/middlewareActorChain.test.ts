/**
 * `server.middleware.auth()` exposes WHO ACTED, and as whom (issue #1520).
 *
 * The actor comes from the session authority's answer (`GET
 * /session/validate/:id` reads it off the session row), never from a header
 * and never from the bearer token — whose claims are undecoded here and
 * therefore attacker-controlled. These cases pin that:
 *
 *  - a bot acting with nobody operating it is reported as its own actor;
 *  - a delegated session reports the person as actor and the account as
 *    effective, so an audit can tell them apart;
 *  - forged headers and forged `act`/`sub` token claims move neither;
 *  - a chain that does not describe the validated session is refused;
 *  - an API that does not report a chain yields `null`, never a guess.
 */

import { getOxyActor } from '../auth';
import { OxyServer } from '../OxyServer';
import type { User } from '../../models/interfaces';

const b64url = (input: string): string =>
  Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const token = (claims: Record<string, unknown>): string =>
  `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...claims }),
  )}.sig`;

interface MockReq {
  method: string;
  path: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  userId?: string | null;
  user?: unknown;
  oxyActor?: unknown;
}

interface MockRes {
  statusCode: number;
  body: unknown;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
}

const makeRes = (): MockRes => ({
  statusCode: 0,
  body: undefined,
  status(code: number) {
    this.statusCode = code;
    return this;
  },
  json(body: unknown) {
    this.body = body;
    return this;
  },
});

const BOT = 'bot-account-1';
const OWNER = 'owner-person-1';
const INTRUDER = 'intruder-1';

function validation(userId: string, actor?: unknown) {
  return {
    valid: true as const,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    lastActivity: new Date().toISOString(),
    user: { id: userId } as User,
    ...(actor === undefined ? {} : { actor }),
  };
}

function chain(effectiveAccountId: string, actorAccountId: string) {
  return {
    schemaVersion: 1,
    effectiveAccountId,
    actorAccountId,
    delegated: effectiveAccountId !== actorAccountId,
  };
}

async function authenticate(
  answer: ReturnType<typeof validation>,
  extra: { headers?: Record<string, string>; claims?: Record<string, unknown>; optional?: boolean } = {},
) {
  const oxy = new OxyServer({ baseURL: 'http://test.invalid' });
  jest.spyOn(oxy.session, 'validate').mockResolvedValue(answer as never);
  const req: MockReq = {
    method: 'GET',
    path: '/whoami',
    query: {},
    headers: {
      authorization: `Bearer ${token({ userId: answer.user.id, sessionId: 'session-1', ...extra.claims })}`,
      ...extra.headers,
    },
  };
  const res = makeRes();
  const next = jest.fn();
  await oxy.middleware.auth({ optional: extra.optional })(
    req as unknown as never,
    res as unknown as never,
    next as unknown as never,
  );
  return { req, res, next };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the actor chain on a user session', () => {
  it('reports a bot acting unoperated as its own actor — never its owner', async () => {
    const { req, next } = await authenticate(validation(BOT, chain(BOT, BOT)));

    expect(next).toHaveBeenCalledWith();
    expect(getOxyActor(req as never)).toEqual(chain(BOT, BOT));
    expect(getOxyActor(req as never)?.actorAccountId).not.toBe(OWNER);
  });

  it('separates the person from the effective account on a delegated session', async () => {
    const { req } = await authenticate(validation(BOT, chain(BOT, OWNER)));

    const actor = getOxyActor(req as never);
    expect(actor).toMatchObject({ effectiveAccountId: BOT, actorAccountId: OWNER, delegated: true });
    expect(req.userId).toBe(BOT);
  });

  it('is not moved by forged headers or forged token claims', async () => {
    const { req } = await authenticate(validation(BOT, chain(BOT, BOT)), {
      headers: {
        'x-oxy-user-id': INTRUDER,
        'x-oxy-actor-id': INTRUDER,
        'x-oxy-operator-id': INTRUDER,
      },
      claims: { act: { sub: INTRUDER }, sub: INTRUDER, operatedByUserId: INTRUDER },
    });

    expect(getOxyActor(req as never)).toEqual(chain(BOT, BOT));
  });

  it('refuses a chain that describes a different account than the session', async () => {
    const { req, res, next } = await authenticate(validation(BOT, chain(INTRUDER, INTRUDER)));

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'SESSION_ACTOR_MISMATCH' });
    expect(req.userId).toBeUndefined();
  });

  it('refuses a malformed chain rather than ignoring it', async () => {
    const { res, next } = await authenticate(
      validation(BOT, { schemaVersion: 1, effectiveAccountId: BOT, actorAccountId: OWNER, delegated: false }),
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('on the optional path, a mismatched chain leaves the request anonymous', async () => {
    const { req, next } = await authenticate(validation(BOT, chain(INTRUDER, INTRUDER)), { optional: true });

    expect(next).toHaveBeenCalledWith();
    expect(req.userId).toBeNull();
    expect(getOxyActor(req as never)).toBeNull();
  });

  it('reports null — not a guess — when the API sends no chain', async () => {
    const { req, next } = await authenticate(validation(BOT));

    expect(next).toHaveBeenCalledWith();
    expect(req.userId).toBe(BOT);
    expect(getOxyActor(req as never)).toBeNull();
  });

  it('getOxyActor ignores a chain that does not describe the authenticated subject', () => {
    const req = { userId: BOT, oxyActor: chain(INTRUDER, INTRUDER) };

    expect(getOxyActor(req as never)).toBeNull();
  });
});
