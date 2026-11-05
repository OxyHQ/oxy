import type { FetchFn } from './client';

/**
 * GitHub trusted publishing (oxy ADR 0057): `oxy-ship` holds no secret. In a
 * GitHub Actions job with `permissions: id-token: write`, GitHub hands the job
 * two variables that let it ask for a signed OIDC token naming its repository,
 * ref and workflow. `oxy-ship` asks for one addressed to the Oxy API, and the
 * API exchanges it at `POST /auth/service-token/github-actions` for a
 * five-minute `updates:publish` service token of the application whose public
 * client id it names — provided that application registered this repository as
 * a trusted publisher.
 */

export const GITHUB_ACTIONS_EXCHANGE_PATH = '/auth/service-token/github-actions';

/** Re-mint this long before the Oxy token expires, so no request carries a dying token. */
const REFRESH_MARGIN_MS = 60_000;

export interface GithubOidcEnvironment {
  /** `ACTIONS_ID_TOKEN_REQUEST_URL` */
  readonly requestUrl: string;
  /** `ACTIONS_ID_TOKEN_REQUEST_TOKEN` */
  readonly requestToken: string;
}

/** The job's OIDC request variables, or null outside a job allowed to request a token. */
export function githubOidcEnvironment(
  env: Record<string, string | undefined> = process.env,
): GithubOidcEnvironment | null {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) return null;
  return { requestUrl, requestToken };
}

/** The audience the Oxy API accepts: its own origin (`https://api.oxy.so`). */
export function oxyAudience(baseURL: string): string {
  return new URL(baseURL).origin;
}

async function readJson(
  response: Awaited<ReturnType<FetchFn>>,
  what: string,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${what} failed (${response.status}): ${text.slice(0, 500)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${what} returned a body that is not JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${what} returned an unexpected body`);
  }
  return parsed as Record<string, unknown>;
}

/** Ask GitHub for an OIDC token addressed to `audience`. */
export async function requestGithubIdToken(
  environment: GithubOidcEnvironment,
  audience: string,
  fetchFn: FetchFn,
): Promise<string> {
  const url = new URL(environment.requestUrl);
  url.searchParams.set('audience', audience);
  const body = await readJson(
    await fetchFn(url.toString(), {
      method: 'GET',
      headers: {
        authorization: `bearer ${environment.requestToken}`,
        accept: 'application/json',
      },
    }),
    'GitHub OIDC token request',
  );
  if (typeof body.value !== 'string' || body.value.length === 0) {
    throw new Error('GitHub OIDC token request returned no token');
  }
  return body.value;
}

export interface OxyServiceToken {
  readonly token: string;
  readonly expiresIn: number;
}

/** Exchange a GitHub OIDC token for an Oxy `updates:publish` service token. */
export async function exchangeGithubIdToken(
  baseURL: string,
  clientId: string,
  idToken: string,
  fetchFn: FetchFn,
): Promise<OxyServiceToken> {
  const body = await readJson(
    await fetchFn(`${baseURL.replace(/\/$/, '')}${GITHUB_ACTIONS_EXCHANGE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ clientId, token: idToken }),
    }),
    'Oxy trusted-publisher token exchange',
  );
  const data = (body.data ?? body) as { token?: unknown; expiresIn?: unknown };
  if (typeof data.token !== 'string' || typeof data.expiresIn !== 'number') {
    throw new Error('Oxy trusted-publisher token exchange returned no token');
  }
  return { token: data.token, expiresIn: data.expiresIn };
}

export interface GithubOidcTokenProviderOptions {
  readonly baseURL: string;
  /** The application's public client id (`oxy_dk_…`). */
  readonly clientId: string;
  readonly environment: GithubOidcEnvironment;
  readonly fetchFn?: FetchFn;
  readonly now?: () => number;
}

/**
 * A `getToken` for {@link ShipClient}: the Oxy service token, re-minted from a
 * fresh GitHub OIDC token whenever the current one is within a minute of
 * expiring. A long export-and-upload outlives one five-minute token; GitHub
 * issues a new OIDC token on every request for the life of the job.
 */
export function createGithubOidcTokenProvider(
  options: GithubOidcTokenProviderOptions,
): () => Promise<string> {
  const fetchFn = options.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  const now = options.now ?? Date.now;
  const audience = oxyAudience(options.baseURL);
  let current: { token: string; refreshAt: number } | null = null;
  let pending: Promise<string> | null = null;

  const mint = async (): Promise<string> => {
    const idToken = await requestGithubIdToken(options.environment, audience, fetchFn);
    const minted = await exchangeGithubIdToken(options.baseURL, options.clientId, idToken, fetchFn);
    current = {
      token: minted.token,
      refreshAt: now() + Math.max(0, minted.expiresIn * 1000 - REFRESH_MARGIN_MS),
    };
    return minted.token;
  };

  return async () => {
    if (current && now() < current.refreshAt) return current.token;
    if (!pending) {
      pending = mint().finally(() => {
        pending = null;
      });
    }
    return pending;
  };
}
