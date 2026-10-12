import type { TrafficType } from '@oxy.so/telemetry/collector';

/**
 * The reviewed map from a Cloudflare-served production hostname to the Oxy
 * service name the oxy.so/dashboard already uses for that product.
 *
 * `cloudflareWebActivity.service.ts` reads each host's request counts from
 * Cloudflare's own zone analytics and publishes them into the ecosystem activity
 * collector. Matching is EXACT on the HTTP Host Cloudflare logged: no suffix,
 * wildcard or fuzzy matching, so a hostname nobody reviewed can never be
 * attributed to a product. A host missing here is simply not measured.
 *
 * Rules for an entry:
 *  - Only Cloudflare-PROXIED web front ends (Workers custom domains or Pages
 *    custom domains). Never an AWS API host: those are DNS-only, and their
 *    backends already report their own traffic through
 *    `createEcosystemTraffic`, so listing one would double count it.
 *  - `zone` is the Cloudflare zone (registrable apex) the host lives in; the
 *    poller resolves it to a zone id with the same read-only token. A zone not
 *    in the token's scope is logged once and skipped, never guessed.
 *  - `service` is the name the retired per-app edge observer used for the same
 *    deployment, so dashboard flows keep their identity.
 *  - `activityType` defaults to `platform`. Cloudflare's per-host count says
 *    nothing about what a request did, so only the identity surfaces (Accounts,
 *    Auth), whose every page is account management, say otherwise.
 *
 * Source of each entry: the deployment's `wrangler.toml` custom-domain route or
 * its Pages deploy workflow/docs, as reported by the edge-observer retirement
 * PRs (2026-10-11). Hosts marked "unconfirmed" come from app metadata rather
 * than a declared route; an unattached host costs nothing (no rows).
 */
export interface CloudflareWebHost {
  readonly host: string;
  readonly zone: string;
  readonly service: string;
  readonly activityType?: TrafficType;
}

export const CLOUDFLARE_WEB_HOSTS: readonly CloudflareWebHost[] = Object.freeze([
  // OxyHQ/oxy — Workers oxy-accounts, oxy-console; Pages oxy-auth.
  { host: 'accounts.oxy.so', zone: 'oxy.so', service: 'accounts', activityType: 'identity' },
  { host: 'auth.oxy.so', zone: 'oxy.so', service: 'auth', activityType: 'identity' },
  { host: 'console.oxy.so', zone: 'oxy.so', service: 'console' },
  // OxyHQ/Alia — Workers alia-app, alia-canvas.
  { host: 'alia.onl', zone: 'alia.onl', service: 'alia' },
  { host: 'canvas.alia.onl', zone: 'alia.onl', service: 'alia' },
  // OxyHQ/Allo — Worker allo-frontend.
  { host: 'allo.you', zone: 'allo.you', service: 'allo' },
  // OxyHQ/Atlas — Pages atlas.
  { host: 'atlas.oxy.so', zone: 'oxy.so', service: 'atlas' },
  // OxyHQ/Clarity — Worker clarity.
  { host: 'clarity.surf', zone: 'clarity.surf', service: 'clarity' },
  // OxyHQ/CrowdSource — Workers crowdsource-frontend, crowdsource-console.
  { host: 'crowdsource.oxy.so', zone: 'oxy.so', service: 'crowdsource' },
  { host: 'console.crowdsource.oxy.so', zone: 'oxy.so', service: 'crowdsource' },
  // OxyHQ/Homiio — Worker homiio-frontend.
  { host: 'homiio.com', zone: 'homiio.com', service: 'homiio' },
  // OxyHQ/Inbox — Worker oxy-inbox.
  { host: 'inbox.oxy.so', zone: 'oxy.so', service: 'inbox' },
  // OxyHQ/Mercaria — Workers mercaria, mercaria-dashboard, mercaria-pos.
  { host: 'mercaria.co', zone: 'mercaria.co', service: 'mercaria' },
  { host: 'dashboard.mercaria.co', zone: 'mercaria.co', service: 'mercaria' },
  { host: 'pos.mercaria.co', zone: 'mercaria.co', service: 'mercaria' },
  // OxyHQ/Moovo — Pages moovo, moovo-go, moovo-hub, moovo-tracker. Only the
  // tracker's custom domain is recorded; the other three are unconfirmed.
  { host: 'moovo.now', zone: 'moovo.now', service: 'moovo' },
  { host: 'go.moovo.now', zone: 'moovo.now', service: 'moovo' },
  { host: 'hub.moovo.now', zone: 'moovo.now', service: 'moovo' },
  { host: 'tracker.moovo.now', zone: 'moovo.now', service: 'moovo' },
  // OxyHQ/Nilo — Worker nilo.
  { host: 'nilo.so', zone: 'nilo.so', service: 'nilo' },
  // OxyHQ/Noted — Worker noted.
  { host: 'noted.oxy.so', zone: 'oxy.so', service: 'noted' },
  // OxyHQ/Peable — Pages peable-frontend, peable-checkout.
  { host: 'peable.to', zone: 'peable.to', service: 'peable' },
  { host: 'checkout.peable.to', zone: 'peable.to', service: 'peable' },
  // OxyHQ/website — Pages oxy-website (oxy.so, and FairCoin's brand host).
  { host: 'oxy.so', zone: 'oxy.so', service: 'website' },
  { host: 'www.oxy.so', zone: 'oxy.so', service: 'website' },
  { host: 'fairco.in', zone: 'fairco.in', service: 'website' },
  { host: 'www.fairco.in', zone: 'fairco.in', service: 'website' },
  // OxyHQ/Syra — Pages syra, syra-studio.
  { host: 'syra.fm', zone: 'syra.fm', service: 'syra' },
  { host: 'studio.syra.fm', zone: 'syra.fm', service: 'syra' },
  // OxyHQ/tnp — Pages tnp. (`get.tnp.network` is deliberately absent: the
  // installer host may be served by the AWS API, which reports itself.)
  { host: 'tnp.network', zone: 'tnp.network', service: 'tnp' },
  // Deliberately ABSENT — Mention. `mention.earth` is proxied by Cloudflare to
  // the Mention backend on AWS, which serves the web app (forwarding to the
  // key-gated `shell.mention.earth` Worker) and reports that traffic itself;
  // counting either host here would double count it.
] satisfies CloudflareWebHost[]);
