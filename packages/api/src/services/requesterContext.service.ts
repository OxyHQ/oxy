import { integerCheck, utf16MaxLength, utf16MinLength } from '@oxy.so/contracts';
/** Short-lived own request attribution across live, authenticated service hops. */
import { randomUUID, sign, verify } from 'node:crypto';
import { z } from '@oxy.so/zod4';
import { capabilityTicketSigningConfig } from '../config/capabilityTicketSigning';
import {
  resolveLiveAgencyWorkloadByHandle,
  type LiveAgencyServicePrincipal,
} from './agencyServicePrincipal.service';
import {
  revalidateForegroundRequester,
  type ForegroundRequesterBinding,
} from './foregroundCapabilityRequester.service';
import { resolveFirstPartyTask, taskAllowsEffectiveAccount } from './firstPartyTasks.service';

const identifier = z.string().check(utf16MinLength(1)).check(utf16MaxLength(128));
const workload = z
  .object({
    applicationId: identifier,
    credentialId: identifier,
    ownerAccountId: identifier,
    environment: z.enum(['development', 'staging', 'production']),
  })
  .strict();
const actor = z
  .object({ type: z.enum(['alia', 'agent', 'requester']), accountId: identifier.optional() })
  .strict();
const source = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), taskId: identifier }).strict(),
  z
    .object({
      kind: z.literal('session'),
      sessionId: identifier,
      digest: z.string().check(utf16MinLength(1)).check(utf16MaxLength(256)),
    })
    .strict(),
]);
const claimsSchema = z
  .object({
    iss: z.string(),
    type: z.literal('oxy_requester_context'),
    authority: z.literal('first_party'),
    jti: identifier,
    iat: z.number().check(integerCheck()),
    exp: z.number().check(integerCheck()),
    source,
    requesterAccountId: identifier,
    effectiveAccountId: identifier,
    actor,
    chain: z.array(workload).min(2).max(8),
  })
  .strict();
export type RequesterContextClaims = z.infer<typeof claimsSchema>;
export type RequesterContextSource = z.infer<typeof source>;
type Workload = z.infer<typeof workload>;
const issuer = () => (process.env.OXY_API_URL ?? 'https://api.oxy.so').replace(/\/$/, '');
const TYPE = 'OXY-REQUESTER-CONTEXT+JWT';

async function workloadRef(presenter: LiveAgencyServicePrincipal): Promise<Workload | null> {
  if (presenter.authority !== 'first_party') return null;
  const binding = await resolveLiveAgencyWorkloadByHandle(
    presenter.applicationId,
    presenter.credentialId,
  );
  if (!binding?.environmentBound || binding.ownerAccountId !== presenter.ownerAccountId)
    return null;
  return {
    applicationId: binding.applicationId,
    credentialId: binding.handle,
    ownerAccountId: binding.ownerAccountId,
    environment: binding.environment,
  };
}
function sameWorkload(a: Workload, b: Workload): boolean {
  return (
    a.applicationId === b.applicationId &&
    a.credentialId === b.credentialId &&
    a.ownerAccountId === b.ownerAccountId &&
    a.environment === b.environment
  );
}
function encode(claims: RequesterContextClaims): string {
  const key = capabilityTicketSigningConfig();
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: TYPE, kid: key.keyId })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify(claimsSchema.parse(claims))).toString('base64url');
  return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), key.privateKey).toString('base64url')}`;
}
function decode(token: string): RequesterContextClaims | null {
  try {
    if (!token || token.length > 16384) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
    const key = capabilityTicketSigningConfig();
    const header = z
      .object({ alg: z.literal('EdDSA'), typ: z.literal(TYPE), kid: z.literal(key.keyId) })
      .strict()
      .parse(JSON.parse(Buffer.from(parts[0], 'base64url').toString()));
    if (
      !header ||
      !verify(
        null,
        Buffer.from(`${parts[0]}.${parts[1]}`),
        key.publicKey,
        Buffer.from(parts[2], 'base64url'),
      )
    )
      return null;
    const claims = claimsSchema.parse(JSON.parse(Buffer.from(parts[1], 'base64url').toString()));
    const now = Math.floor(Date.now() / 1000);
    if (
      claims.iss !== issuer() ||
      claims.exp <= now ||
      claims.iat > now + 5 ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 60
    )
      return null;
    return claims;
  } catch {
    return null;
  }
}

export async function resolveRequesterContext(
  token: string,
  presenter: LiveAgencyServicePrincipal,
): Promise<{ claims: RequesterContextClaims; binding: ForegroundRequesterBinding } | null> {
  const claims = decode(token);
  if (!claims) return null;
  const holder = await workloadRef(presenter);
  if (!holder || !sameWorkload(holder, claims.chain[claims.chain.length - 1])) return null;
  const principals: LiveAgencyServicePrincipal[] = [];
  for (const expected of claims.chain) {
    const candidate = { ...expected, authority: 'first_party' as const, capabilities: [] };
    const live = await workloadRef(candidate);
    if (!live || !sameWorkload(live, expected) || live.environment !== holder.environment)
      return null;
    principals.push(candidate);
  }
  let binding: ForegroundRequesterBinding;
  if (claims.source.kind === 'task') {
    const task = await resolveFirstPartyTask(claims.source.taskId, principals[0]);
    if (
      !task ||
      task.requesterAccountId !== claims.requesterAccountId ||
      task.actorType !== claims.actor.type ||
      (task.actorAccountId ?? undefined) !== claims.actor.accountId ||
      !(await taskAllowsEffectiveAccount(task, claims.effectiveAccountId, claims.actor)) ||
      task.expiresAt.getTime() < claims.exp * 1000
    )
      return null;
    binding = {
      sessionId: task.requesterSessionId,
      digest: task.requesterSessionBindingDigest,
      principalAccountId: task.requesterAccountId,
      subjectAccountId: claims.effectiveAccountId,
      expiresAt: new Date(claims.exp * 1000),
    };
  } else {
    binding = {
      sessionId: claims.source.sessionId,
      digest: claims.source.digest,
      principalAccountId: claims.requesterAccountId,
      subjectAccountId: claims.effectiveAccountId,
      expiresAt: new Date(claims.exp * 1000),
    };
    if (
      claims.actor.type !== 'requester' ||
      claims.actor.accountId !== claims.requesterAccountId ||
      !(await revalidateForegroundRequester(binding, principals[0]))
    )
      return null;
  }
  return { claims, binding: { ...binding, forwardedContext: claims } };
}

/** Caller proof has already been verified against its service JWT and receiver audience. */
export async function issueRequesterContext(input: {
  caller: LiveAgencyServicePrincipal;
  receiver: LiveAgencyServicePrincipal;
  binding: ForegroundRequesterBinding;
  source: RequesterContextSource;
  actor: RequesterContextClaims['actor'];
  previous?: RequesterContextClaims;
}): Promise<string | null> {
  const caller = await workloadRef(input.caller),
    receiver = await workloadRef(input.receiver);
  if (!caller || !receiver || caller.environment !== receiver.environment) return null;
  const now = Math.floor(Date.now() / 1000);
  const previous = input.previous;
  if (
    previous &&
    (!sameWorkload(previous.chain[previous.chain.length - 1], caller) || previous.chain.length >= 8)
  )
    return null;
  const exp = Math.min(
    now + 60,
    Math.floor(input.binding.expiresAt.getTime() / 1000),
    previous?.exp ?? Infinity,
  );
  if (exp <= now) return null;
  const claims: RequesterContextClaims = previous
    ? { ...previous, exp, jti: randomUUID(), chain: [...previous.chain, receiver] }
    : {
        iss: issuer(),
        type: 'oxy_requester_context',
        authority: 'first_party',
        jti: randomUUID(),
        iat: now,
        exp,
        source: input.source,
        requesterAccountId: input.binding.principalAccountId,
        effectiveAccountId: input.binding.subjectAccountId,
        actor: input.actor,
        chain: [caller, receiver],
      };
  return encode(claims);
}
