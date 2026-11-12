/**
 * Accounts' additions to the Oxy CSP baseline, read by
 * `packages/core/scripts/writePagesHeaders.ts` after the export.
 *
 * What the embedded Alia SDK loads (its API and voice socket, the avatar runtime,
 * the voice worklets) is the SDK's own declaration, composed in with
 * `withAliaSdkCsp`: no Alia origin is written here. What stays is Accounts' own:
 * the service worker, `blob:` images and fetches, and PostHog.
 *
 * The one exception is {@link GEMIES_TRANSITION_ORIGINS}. Alia's backend becomes
 * Gemies (Gemies ADR 0034) and the SDK moves from `api.alia.onl` to
 * `api.gemies.ai`; until Accounts composes `@gemies/sdk/csp` instead of
 * `@alia.onl/sdk/csp`, the Gemies origins are allowed here so the move never
 * waits on a CSP change. Delete them with the switch to `@gemies/sdk/csp`.
 */
import { withAliaSdkCsp } from '@alia.onl/sdk/csp';
import type { OxyPagesHeadersOptions } from '@oxy.so/core/server';

/** The Gemies API (HTTP and its voice WebSocket) and web app, mirroring the SDK's own shape. */
const GEMIES_TRANSITION_ORIGINS = {
  api: 'https://api.gemies.ai',
  voiceSocket: 'wss://api.gemies.ai',
  web: 'https://gemies.ai',
} as const;

export default {
  csp: withAliaSdkCsp({
    workerSrc: ["'self'"],
    imgSrc: ['blob:', GEMIES_TRANSITION_ORIGINS.api],
    connectSrc: [
      'blob:',
      'https://eu.i.posthog.com',
      GEMIES_TRANSITION_ORIGINS.api,
      GEMIES_TRANSITION_ORIGINS.voiceSocket,
      GEMIES_TRANSITION_ORIGINS.web,
    ],
    scriptSrc: [GEMIES_TRANSITION_ORIGINS.web],
    mediaSrc: [GEMIES_TRANSITION_ORIGINS.api],
  }),
} satisfies OxyPagesHeadersOptions;
