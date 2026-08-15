/**
 * Turns the raw OAuth scope strings the server resolves for an approval request
 * into the short "<app> will receive" lines the Commons approval screen shows.
 *
 * The scope COPY is not defined here: every known scope maps to a `consent.*`
 * key that already exists in `@oxyhq/core`'s dictionaries (all 11 locales), the
 * same sentences the OAuth consent screen shows. Commons' `t()` falls through to
 * core, so reusing those keys keeps one wording per permission across the
 * ecosystem instead of a second, drifting Commons-only copy.
 *
 * An UNKNOWN scope is never hidden and never guessed at — it is passed through
 * verbatim, so a permission this build has no sentence for is still shown to the
 * person granting it.
 *
 * Pure + dependency-free, so it unit-tests directly.
 */

/** Known scope -> shared `@oxyhq/core` consent sentence. */
const SCOPE_LABEL_KEYS: Readonly<Record<string, string>> = {
  openid: 'consent.scopes.openid',
  profile: 'consent.scopes.profile',
  'profile:read': 'consent.scopes.profile',
  email: 'consent.scopes.email',
  'email:read': 'consent.scopes.email',
  offline_access: 'consent.scopes.offlineAccess',
  'user:read': 'consent.scopes.userRead',
  'files:read': 'consent.scopes.filesRead',
  'files:write': 'consent.scopes.filesWrite',
  'files:delete': 'consent.scopes.filesDelete',
  'webhooks:receive': 'consent.scopes.webhooksReceive',
  'inference:invoke': 'consent.scopes.inferenceInvoke',
  'inference:models:read': 'consent.scopes.inferenceModelsRead',
  'inference:usage:read': 'consent.scopes.inferenceUsageRead',
  'inference:routing:read': 'consent.scopes.inferenceRoutingRead',
  'inference:routing:write': 'consent.scopes.inferenceRoutingWrite',
  'inference:providers:read': 'consent.scopes.inferenceProvidersRead',
  'inference:providers:write': 'consent.scopes.inferenceProvidersWrite',
  'federation:write': 'consent.scopes.federationWrite',
};

/**
 * One line of the "will receive" list.
 *
 * `translationKey` is present when the scope has a shared consent sentence; the
 * caller renders `t(translationKey)`. Otherwise the caller renders `scope`
 * verbatim.
 */
export interface ScopeLine {
  /** Stable list key — the first scope that produced this line. */
  scope: string;
  translationKey?: string;
}

/**
 * Summarize the request's scopes into display lines.
 *
 * De-duplicates by RESOLVED meaning (so `profile` and `profile:read` produce one
 * line, not two identical ones) while preserving the server's ordering, and
 * ignores blank entries. An empty result means the request carries no scopes —
 * the caller shows the baseline "sign you in" sentence instead of nothing.
 *
 * @param scopes - Scopes exactly as resolved server-side for this request.
 */
export function summarizeScopes(scopes: readonly string[]): ScopeLine[] {
  const lines: ScopeLine[] = [];
  const seen = new Set<string>();

  for (const raw of scopes) {
    if (typeof raw !== 'string') continue;
    const scope = raw.trim();
    if (!scope) continue;

    const translationKey = SCOPE_LABEL_KEYS[scope];
    const identity = translationKey ?? `raw:${scope}`;
    if (seen.has(identity)) continue;
    seen.add(identity);

    lines.push(translationKey ? { scope, translationKey } : { scope });
  }

  return lines;
}
