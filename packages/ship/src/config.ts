import { ShipClient, type FetchFn } from './client';
import { requireString, baseUrlFlag, type ShipFlags } from './args';
import { createGithubOidcTokenProvider, githubOidcEnvironment } from './githubOidc';

/**
 * Build an authenticated ShipClient from flags/env.
 *
 * Authentication is GitHub trusted publishing and nothing else: no secret is
 * read or accepted. The job's OIDC token is exchanged for a short-lived
 * `updates:publish` token of the application named by its public client id
 * (`--client-id`/`OXY_SHIP_CLIENT_ID`); the API origin comes from
 * `--url`/`--api-url`/`OXY_API_URL` (default production).
 */
export function createShipClient(
  flags: ShipFlags,
  deps: { env?: Record<string, string | undefined>; fetchFn?: FetchFn } = {},
): ShipClient {
  const baseURL = baseUrlFlag(flags);
  const clientId = requireString(flags, 'client-id', 'OXY_SHIP_CLIENT_ID');
  const environment = githubOidcEnvironment(deps.env ?? process.env);
  if (!environment) {
    throw new Error(
      'oxy-ship authenticates with GitHub Actions OIDC and holds no secret: run it in a ' +
        'GitHub Actions job with `permissions: id-token: write` whose repository is a ' +
        'trusted publisher of the application (ACTIONS_ID_TOKEN_REQUEST_URL is not set). ' +
        'Roll back, promote or change a rollout by hand in the Oxy Console Updates tab.',
    );
  }
  const getToken = createGithubOidcTokenProvider({
    baseURL,
    clientId,
    environment,
    fetchFn: deps.fetchFn,
  });
  return new ShipClient({ baseURL, getToken, fetchFn: deps.fetchFn });
}
