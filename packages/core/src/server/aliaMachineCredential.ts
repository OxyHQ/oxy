import type { Request, RequestHandler } from 'express';
import type { OxyServiceEnvironment } from './auth';

/** Stable resource identity, shared with the Oxy control plane. Not a display name. */
export const OXY_ALIA_RESOURCE_APPLICATION_ID = '6a2f851751b784a86fd0e934';
export const OXY_ALIA_MACHINE_SCOPES = ['alia:chat', 'inference:invoke'] as const;

/** App-only assistant turn: no human subject, service tier or delegated authority. */
export interface OxyAliaMachinePrincipal {
  readonly kind: 'machine';
  readonly audience: typeof OXY_ALIA_RESOURCE_APPLICATION_ID;
  readonly applicationId: string;
  readonly credentialId: string;
  readonly ownerAccountId: string;
  readonly environment: OxyServiceEnvironment;
  readonly scopes: readonly ['alia:chat', 'inference:invoke'];
}

export type AliaMachineCredentialIntrospection =
  | { active: false }
  | { active: true; principal: OxyAliaMachinePrincipal };

export interface OxyAliaMachineCredentialHost {
  readonly apps: {
    introspectAliaMachineCredential(token: string): Promise<AliaMachineCredentialIntrospection>;
  };
}

export interface OxyAliaMachineRequest extends Request {
  machineCredential?: OxyAliaMachinePrincipal;
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value;
}

/** Strict response boundary: extra user/tier fields cannot smuggle authority. */
export function isOxyAliaMachinePrincipal(value: unknown): value is OxyAliaMachinePrincipal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const keys = ['kind', 'audience', 'applicationId', 'credentialId', 'ownerAccountId', 'environment', 'scopes'];
  return Object.keys(p).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(p, key))
    && p.kind === 'machine' && p.audience === OXY_ALIA_RESOURCE_APPLICATION_ID
    && id(p.applicationId) && id(p.credentialId) && id(p.ownerAccountId)
    && typeof p.environment === 'string' && ['production', 'staging', 'development'].includes(p.environment)
    && Array.isArray(p.scopes) && p.scopes.length === 2
    && OXY_ALIA_MACHINE_SCOPES.every(scope => (p.scopes as unknown[]).includes(scope));
}

// Keep the forwarding credential out of enumerable request/principal objects,
// logs, response serialization and persistent SDK/session state. No cache.
const forwardingCredentials = new WeakMap<Request, { principal: OxyAliaMachinePrincipal; bearer: string }>();

/** Only for the request-scoped Oxy inference client; never for a user API. */
export function getOxyAliaMachineCredentialBearer(req: Request): string | null {
  const bound = forwardingCredentials.get(req);
  return bound && (req as OxyAliaMachineRequest).machineCredential === bound.principal ? bound.bearer : null;
}

/** Opt into Alia's app-only chat lane on its two chat routes, never globally. */
export function createOxyAliaMachineCredentialAuth(
  server: OxyAliaMachineCredentialHost,
  options: { environment: OxyServiceEnvironment },
): RequestHandler {
  return async (req, res, next) => {
    const auth = req.headers.authorization;
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token.startsWith('oxy_sk_') || token.length > 2048) {
      res.status(401).json({ error: 'MACHINE_CREDENTIAL_INVALID' });
      return;
    }
    const existing = req as Request & { user?: unknown; userId?: unknown; serviceApp?: unknown; oxyRequester?: unknown };
    if (existing.user || existing.userId || existing.serviceApp || existing.oxyRequester
      || (req as OxyAliaMachineRequest).machineCredential
      || req.headers['x-oxy-user-id'] !== undefined || req.headers['x-oxy-requester-assertion'] !== undefined) {
      res.status(403).json({ error: 'MACHINE_USER_DELEGATION_UNSUPPORTED' });
      return;
    }
    try {
      const answer = await server.apps.introspectAliaMachineCredential(token);
      if (!answer.active || !isOxyAliaMachinePrincipal(answer.principal) || answer.principal.environment !== options.environment) {
        res.status(401).json({ error: 'MACHINE_CREDENTIAL_INVALID' });
        return;
      }
      const principal = Object.freeze({ ...answer.principal, scopes: Object.freeze(['alia:chat', 'inference:invoke'] as const) });
      (req as OxyAliaMachineRequest).machineCredential = principal;
      forwardingCredentials.set(req, { principal, bearer: token });
      next();
    } catch {
      // Transport errors may contain request data; never expose or log them.
      res.status(503).json({ error: 'MACHINE_CREDENTIAL_VERIFIER_UNAVAILABLE' });
    }
  };
}
