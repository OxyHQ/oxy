import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AccountAuditEntry } from '@/hooks/use-account-audit';
import type { AccountAuditSubject } from '@/lib/account-audit';
import {
  ACCOUNT_AUDIT_PERMISSIONS,
  accountAuditAccess,
  accountAuditActorLabel,
  accountAuditActorUserId,
  accountAuditSourceLabel,
  accountAuditVariant,
} from '@/lib/account-audit';

/**
 * The fixtures are the rows `GET /accounts/:id/audit` actually projects, taken
 * from the mapper that builds them (`accountAuditTrail.service.ts`, `pageOf` /
 * `actorOf`) and from the cases its own suite drives — a refused credential
 * validation, a member rotation, a `service` connection event and a `platform`
 * one, plus a pre-#1043 row with no recorded kind.
 *
 * Five actor arms exist and THREE of them carry no user id. That is the whole
 * reason this file exists: a screen that asked "is there an actor id" would
 * collapse `service`, `platform`, `none` and `unknown` into one sentence, and it
 * would be wrong on the most numerous row in the trail — `recordProviderConnectionUse`
 * writes every `used` event as `platform`. That bug shipped once (#1063) and the
 * suite that missed it asserted only the `user` arm.
 */
const REFUSED_VALIDATION: AccountAuditEntry = {
  source: 'application_credential',
  eventType: 'validation_failed',
  actor: { kind: 'none' },
  subjectId: 'cred_1',
  applicationId: 'app_1',
  reason: 'scope_missing',
  environment: 'development',
  createdAt: '2026-08-18T13:00:02.000Z',
};

const MEMBER_ROTATION: AccountAuditEntry = {
  source: 'application_credential',
  eventType: 'rotated',
  actor: { kind: 'user', userId: '01a01042-0000-7000-8000-000000000000' },
  subjectId: 'cred_1',
  applicationId: 'app_1',
  reason: null,
  environment: 'development',
  createdAt: '2026-08-18T13:00:01.000Z',
};

const SERVICE_USE: AccountAuditEntry = {
  source: 'provider_connection',
  eventType: 'used',
  actor: { kind: 'service' },
  subjectId: 'conn_1',
  applicationId: null,
  reason: null,
  environment: 'production',
  createdAt: '2026-08-18T13:00:00.000Z',
};

const PLATFORM_USE: AccountAuditEntry = {
  source: 'provider_connection',
  eventType: 'used',
  actor: { kind: 'platform' },
  subjectId: 'conn_1',
  applicationId: null,
  reason: null,
  environment: 'production',
  createdAt: '2026-08-18T12:59:59.000Z',
};

const PRE_1043_ROW: AccountAuditEntry = {
  source: 'provider_connection',
  eventType: 'validated',
  actor: { kind: 'unknown' },
  subjectId: 'conn_1',
  applicationId: null,
  reason: null,
  environment: 'production',
  createdAt: '2026-08-18T12:00:00.000Z',
};

describe('accountAuditActorLabel', () => {
  /**
   * THE load-bearing case. `service` and `platform` are the two arms that a
   * null-id check cannot tell apart, and they are opposite claims: the customer's
   * own credential did this, versus Oxy's machinery did it with no principal at
   * all.
   *
   * Reverting this function to `actorUserId === null ? 'by a service credential'
   * : 'by a member'` makes this assertion fail on the `platform` row, which is
   * the mutation that has to die.
   */
  it('does not call the platform a service credential', () => {
    expect(accountAuditActorLabel(PLATFORM_USE)).toBe('by the platform');
    expect(accountAuditActorLabel(SERVICE_USE)).toBe('by a service credential');
    expect(accountAuditActorLabel(PLATFORM_USE)).not.toBe(
      accountAuditActorLabel(SERVICE_USE)
    );
  });

  /**
   * The other pair a null id collapses: a refusal has NO actor, and that is a
   * different statement from an unrecorded one. `none` says a request arrived and
   * was turned away; `unknown` says the row never recorded who acted. Neither may
   * borrow the other's words, and neither may borrow the service credential's.
   */
  it('keeps "nobody acted" apart from "we did not record who"', () => {
    expect(accountAuditActorLabel(REFUSED_VALIDATION)).toBe('a refused request');
    expect(accountAuditActorLabel(PRE_1043_ROW)).toBe('actor not recorded');
    expect(accountAuditActorLabel(REFUSED_VALIDATION)).not.toContain('service');
    expect(accountAuditActorLabel(PRE_1043_ROW)).not.toContain('service');
  });

  /**
   * All five arms, all distinct — the assertion that fails under ANY collapse,
   * whichever pair a future edit merges.
   */
  it('gives each of the five arms its own sentence', () => {
    const labels = [
      accountAuditActorLabel(MEMBER_ROTATION),
      accountAuditActorLabel(SERVICE_USE),
      accountAuditActorLabel(PLATFORM_USE),
      accountAuditActorLabel(REFUSED_VALIDATION),
      accountAuditActorLabel(PRE_1043_ROW),
    ];

    expect(new Set(labels).size).toBe(5);
  });

  /**
   * Read from the KIND, not from anything correlated with it.
   *
   * The fields are fed in DISAGREEMENT: a `validation_failed` event whose actor
   * is `platform`, and a `used` event whose actor is `none`. Neither combination
   * is one the server writes — which is the point. An implementation reading
   * `eventType` (the field that correlates with `none` on every real row) answers
   * both of these backwards, while one reading `actor.kind` is unmoved.
   */
  it('reads the actor kind rather than the event type it correlates with', () => {
    expect(
      accountAuditActorLabel({ ...REFUSED_VALIDATION, actor: { kind: 'platform' } })
    ).toBe('by the platform');
    expect(accountAuditActorLabel({ ...PLATFORM_USE, actor: { kind: 'none' } })).toBe(
      'a refused request'
    );
  });
});

describe('accountAuditActorUserId', () => {
  it('shows an id for the one arm that has one', () => {
    expect(accountAuditActorUserId(MEMBER_ROTATION)).toBe(
      '01a01042-0000-7000-8000-000000000000'
    );
  });

  it('has no id to show for any of the other four', () => {
    for (const entry of [SERVICE_USE, PLATFORM_USE, REFUSED_VALIDATION, PRE_1043_ROW]) {
      expect(accountAuditActorUserId(entry)).toBeNull();
    }
  });
});

describe('accountAuditVariant', () => {
  it('marks a refused validation, and only a refused validation, as a problem', () => {
    expect(accountAuditVariant(REFUSED_VALIDATION)).toBe('destructive');
    // A revoke and a disable are deliberate acts by somebody entitled to perform
    // them. Colouring those red is how a trail stops being read.
    for (const eventType of ['created', 'rotated', 'revoked', 'disabled', 'used'] as const) {
      expect(accountAuditVariant({ eventType })).toBe('outline');
    }
  });
});

describe('accountAuditSourceLabel', () => {
  it('names each source in the words the screen uses', () => {
    expect(accountAuditSourceLabel('application_credential')).toBe('credential');
    expect(accountAuditSourceLabel('provider_connection')).toBe('provider connection');
  });
});

describe('accountAuditAccess', () => {
  /** A member of somebody else's account, holding exactly these permissions. */
  function member(permissions: Array<string>): AccountAuditSubject {
    return { relationship: 'member', callerMembership: { permissions } };
  }

  it('permits a membership holding both', () => {
    expect(
      accountAuditAccess(member(['account:read', 'credentials:read', 'inference:providers:read']))
    ).toEqual({ kind: 'permitted' });
  });

  /**
   * The caller's OWN personal account has no membership row: the API grants
   * every owner permission implicitly and sends `callerMembership: null` beside
   * `relationship: 'self'`, because there is genuinely no row to send.
   *
   * A gate reading only the row refuses the owner their own trail — on the
   * account the Console defaults to. The next case is this one's control: the
   * SAME null membership under any other relationship is a refusal, so this is
   * not "a null membership passes".
   */
  it('permits the owner of their own personal account, which has no membership row', () => {
    expect(accountAuditAccess({ relationship: 'self', callerMembership: null })).toEqual({
      kind: 'permitted',
    });
  });

  it('refuses the same null membership when the relationship is not self', () => {
    expect(accountAuditAccess({ relationship: 'owner', callerMembership: null })).toEqual({
      kind: 'refused',
      missing: ['credentials:read', 'inference:providers:read'],
    });
  });

  /**
   * The case the whole rule exists for. A `developer` holds `credentials:read`
   * and not `inference:providers:read`, so half the trail is readable to them —
   * and the route refuses rather than serving that half, because a list covering
   * half an account while reading as the whole of it is the one failure an audit
   * view must not have.
   *
   * The refusal NAMES what is missing, which is why `missing` is a list: "you are
   * missing one of two" is not something anybody can act on.
   */
  it('refuses a caller holding only one of the two, and says which is missing', () => {
    expect(accountAuditAccess(member(['account:read', 'credentials:read']))).toEqual({
      kind: 'refused',
      missing: ['inference:providers:read'],
    });
    expect(accountAuditAccess(member(['account:read', 'inference:providers:read']))).toEqual({
      kind: 'refused',
      missing: ['credentials:read'],
    });
  });

  it('refuses a viewer, who holds neither, naming both', () => {
    expect(accountAuditAccess(member(['account:read']))).toEqual({
      kind: 'refused',
      missing: ['credentials:read', 'inference:providers:read'],
    });
  });

  it('treats an absent membership as refused rather than as permitted', () => {
    expect(accountAuditAccess({ relationship: 'member', callerMembership: null })).toEqual({
      kind: 'refused',
      missing: ['credentials:read', 'inference:providers:read'],
    });
  });

  /**
   * A permission that merely LOOKS like one of the two does not satisfy it —
   * the check is exact membership, not a prefix or a substring.
   */
  it('is not satisfied by a neighbouring permission', () => {
    expect(accountAuditAccess(member(['credentials:create', 'inference:providers:write']))).toEqual({
      kind: 'refused',
      missing: ['credentials:read', 'inference:providers:read'],
    });
  });
});

/**
 * The client's refusal rule and the server's gate are the same two permissions,
 * asserted against the ROUTE ITSELF rather than against a copy of it.
 *
 * Without this, `ACCOUNT_AUDIT_PERMISSIONS` is a hand-written restatement that
 * can drift the moment the route changes: relax the API to one permission and
 * the Console would go on refusing people the server would serve, and — worse in
 * the other direction — tighten it to three and the Console would send a request
 * it knows will be refused while telling the user they are permitted.
 *
 * The extractor is anchored to the route's own registration and given a control:
 * the same function run over the BILLING audit route must return `billing:read`
 * alone. A regex that matched the whole file, or nothing at all, fails that.
 */
describe('the two permissions are the route\'s own', () => {
  const ACCOUNTS_ROUTE = fileURLToPath(
    new URL('../../../../api/src/routes/accounts.ts', import.meta.url)
  );

  /** Every `requireAccountPermission` between one route registration and the next. */
  function gateOf(source: string, path: string): Array<string> {
    const start = source.indexOf(`'${path}',`);
    expect(start, `route ${path} is not registered in accounts.ts`).toBeGreaterThan(-1);
    const next = source.indexOf('router.', start);
    const registration = source.slice(start, next === -1 ? undefined : next);
    return [...registration.matchAll(/requireAccountPermission\('([^']+)'\)/g)].map(
      (match) => match[1]
    );
  }

  const source = readFileSync(ACCOUNTS_ROUTE, 'utf8');

  it('demands exactly what the server demands', () => {
    expect(gateOf(source, '/:id/audit')).toEqual([...ACCOUNT_AUDIT_PERMISSIONS]);
  });

  /**
   * The control. It proves the extractor reads ONE registration rather than the
   * file — a version that returned every permission in `accounts.ts` would pass
   * the assertion above by accident and fail here.
   */
  it('reads one route, not the file', () => {
    expect(gateOf(source, '/:id/billing/audit')).toEqual(['billing:read']);
  });
});
