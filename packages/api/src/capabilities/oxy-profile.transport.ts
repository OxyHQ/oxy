import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Request, Response } from 'express';
import { canonicalCapabilityJson, type CapabilityTicketClaims } from '@oxy.so/contracts';
import { createLiveCapabilityTicketVerifier } from '@oxy.so/core/server';
import { createInternalCatalogMcpHttpService } from '@oxy.so/mcp';
import { capabilityTicketSigningConfig } from '../config/capabilityTicketSigning';
import { activeCapabilityCatalog, digestCatalog } from '../services/capabilityCatalog.service';
import { reauthorizeCapabilityTicket } from '../services/capabilityAuthority.service';
import { oxyProfileCapabilityCatalog } from './oxy-profile.catalog';
import { executeOxyProfileRead } from './oxy-profile.handlers';

function ticketVerifier() {
  const signing = capabilityTicketSigningConfig();
  return createLiveCapabilityTicketVerifier({
    issuer: process.env.OXY_API_URL ?? 'https://api.oxy.so',
    audience: 'oxy-platform-api',
    resolvePublicKey: (keyId) => (keyId === signing.keyId ? signing.publicKey : undefined),
    introspect: async (ticket, { signal }) => {
      signal.throwIfAborted();
      // Oxy is this catalogue's authority and receiver. Use the same signed
      // verification/live authority as its service-authenticated introspection.
      const { verifyCapabilityTicket } = await import('@oxy.so/core/server');
      const claims = verifyCapabilityTicket(ticket, {
        issuer: process.env.OXY_API_URL ?? 'https://api.oxy.so',
        audience: 'oxy-platform-api',
        resolvePublicKey: (keyId) => (keyId === signing.keyId ? signing.publicKey : undefined),
      });
      const decision = await reauthorizeCapabilityTicket(claims);
      signal.throwIfAborted();
      return { active: decision.allowed, claims, decision };
    },
  });
}

async function registeredDomain() {
  const catalog = oxyProfileCapabilityCatalog();
  const registration = await activeCapabilityCatalog('oxy');
  if (
    !registration ||
    registration.version !== catalog.version ||
    registration.digest !== digestCatalog(catalog) ||
    canonicalCapabilityJson(registration.catalog) !== canonicalCapabilityJson(catalog)
  ) {
    throw new Error('Canonical Oxy profile catalogue is not registered');
  }
  return {
    catalog,
    binding: {
      registrationId: registration.id,
      version: registration.version,
      digest: registration.digest,
    },
  };
}

export async function handleOxyProfileInternalMcp(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const { catalog, binding } = await registeredDomain();
    const service = createInternalCatalogMcpHttpService({
      catalog,
      binding,
      verifyTicket: ticketVerifier(),
      handlers: Object.fromEntries(
        catalog.tools.map((tool) => [
          tool.name,
          async (input, context) => {
            if (context.principal.kind !== 'capability')
              throw new Error('Capability principal required');
            return {
              structuredContent: await executeOxyProfileRead(input, context.principal.claims),
            };
          },
        ]),
      ),
      resolveResource: (_input, context) => ({
        appId: 'oxy',
        resourceType: 'account',
        resourceId: context.principal.claims.resource.effectiveAccountId,
        effectiveAccountId: context.principal.claims.resource.effectiveAccountId,
      }),
      authorize: async (_input, context) => {
        if (context.principal.kind !== 'capability')
          return { allowed: false, reason: 'capability_required' };
        const claims = context.principal.claims;
        if (
          claims.actor.type !== 'requester' ||
          !(await reauthorizeCapabilityTicket(claims)).allowed
        ) {
          return { allowed: false, reason: 'foreground_authority_required' };
        }
        return { allowed: true, effectiveAccountId: claims.resource.effectiveAccountId };
      },
    });
    await service.handleMcp(request, response);
  } catch {
    request.resume();
    if (!response.headersSent && !response.destroyed) {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'foreground_invocation_refused' }));
    }
  }
}

/** Shared Capability HTTP adapter; the domain handler is also used by MCP. */
export function oxyProfileCapabilityRead(tool: 'readViewerGraph' | 'recommendProfiles') {
  return async (request: Request, response: Response) => {
    try {
      const { binding } = await registeredDomain();
      const match = request.get('authorization')?.match(/^Capability ([A-Za-z0-9_.-]+)$/i);
      if (!match) {
        response.status(401).json({ error: 'capability_required' });
        return;
      }
      const claims: CapabilityTicketClaims = await ticketVerifier()(match[1]);
      if (
        claims.tool !== tool ||
        canonicalCapabilityJson(claims.catalog) !== canonicalCapabilityJson(binding)
      ) {
        response.status(403).json({ error: 'foreground_invocation_refused' });
        return;
      }
      if (
        tool === 'readViewerGraph' &&
        (Object.keys(request.query).length > 0 ||
          (request.body && Object.keys(request.body).length > 0))
      ) {
        response.status(403).json({ error: 'foreground_invocation_refused' });
        return;
      }
      const result = await executeOxyProfileRead(
        tool === 'readViewerGraph' ? {} : request.body,
        claims,
      );
      response.json(result);
    } catch {
      response.status(403).json({ error: 'foreground_invocation_refused' });
    }
  };
}
