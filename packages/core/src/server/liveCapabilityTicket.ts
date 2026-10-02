import { canonicalCapabilityJson, capabilityTicketClaimsSchema, type CapabilityTicketClaims } from '@oxy.so/contracts';
import { verifyCapabilityTicket, type CapabilityTicketVerificationOptions } from './capabilityTicket';
import type { CapabilityTicketIntrospection } from './namespaces';

export interface LiveCapabilityTicketVerifierOptions extends CapabilityTicketVerificationOptions {
  issuer: string;
  introspect: (ticket: string, options: { signal: AbortSignal }) => Promise<CapabilityTicketIntrospection>;
  /** Network bound only; does not establish an authority freshness policy. */
  timeoutMs?: number;
}

/** Local signature + live receiving-service introspection; no cache or retry. */
export function createLiveCapabilityTicketVerifier(options: LiveCapabilityTicketVerifierOptions) {
  if (typeof options.issuer !== 'string' || options.issuer.trim() === '') throw new Error('A trusted Capability issuer is required');
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new Error('Capability introspection timeout must be between 1 and 60000ms');
  }
  return async (ticket: string, input: { signal?: AbortSignal } = {}): Promise<CapabilityTicketClaims> => {
    input.signal?.throwIfAborted();
    const signed = verifyCapabilityTicket(ticket, options);
    if (!signed.catalog) throw new Error('Internal MCP requires a signed catalogue binding');
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Capability introspection timed out')), timeoutMs);
    let rejectAbort: (() => void) | undefined;
    try {
      const interrupted = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(controller.signal.reason ?? new Error('Capability introspection aborted'));
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
        if (controller.signal.aborted) rejectAbort();
      });
      const result = await Promise.race([options.introspect(ticket, { signal: controller.signal }), interrupted]);
      controller.signal.throwIfAborted();
      if (result.active !== true) throw new Error('Capability ticket is inactive');
      const live = capabilityTicketClaimsSchema.parse(result.claims);
      if (canonicalCapabilityJson(live) !== canonicalCapabilityJson(signed)) throw new Error('Capability introspection claims mismatch');
      // An authority response delayed past expiry cannot extend the signed grant.
      return verifyCapabilityTicket(ticket, options);
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
    }
  };
}
