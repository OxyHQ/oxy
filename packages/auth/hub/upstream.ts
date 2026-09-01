/**
 * The edge's calls to `api.oxy.so`.
 *
 * Everything the hub does server-side goes through here, so there is exactly one
 * place that knows the API's envelope shape (`{ data }` on success, `{ error }`
 * on failure) and exactly one place a bearer or a raw handle is put on the wire.
 *
 * Issue #937 Phase 5, ADR 0003.
 */

/**
 * The Pages environment this layer reads.
 *
 * `OXY_API_URL` is a plain Pages variable, not a secret — the same value the SPA
 * bundle already carries. The edge holds NO secret of its own: it authenticates
 * to the API with the browser's own credentials (the hub handle, or a bearer
 * minted for the browser's device) and never with a service credential, which is
 * what keeps a bug here from being able to act for anybody but the caller.
 */
export interface HubEnv {
  OXY_API_URL?: string;
}

const DEFAULT_API_URL = 'https://api.oxy.so';

export function apiBaseUrl(env: HubEnv): string {
  const configured = env.OXY_API_URL?.trim();
  return (configured && configured.length > 0 ? configured : DEFAULT_API_URL).replace(/\/+$/, '');
}

/**
 * The outcome of one upstream call, as a value rather than an exception.
 *
 * The failure arm carries the API's own error code — `invalid_handle` and
 * `no_active_session` mean different things to the caller and only one of them
 * may clear the cookie — plus the status, so a 5xx is never mistaken for a
 * credential verdict.
 */
export interface UpstreamFailure {
  ok: false;
  status: number;
  code: string;
}

export type UpstreamResult<T> = { ok: true; data: T } | UpstreamFailure;

async function readError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const error = (body as { error: unknown }).error;
      if (typeof error === 'string') return error;
      // The shared error middleware answers `{ error: { code, message } }`.
      if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = (error as { code: unknown }).code;
        if (typeof code === 'string') return code;
      }
    }
  } catch {
    // A non-JSON body is an infrastructure failure, not an API verdict. Fall
    // through to the generic code rather than surfacing whatever HTML a proxy
    // decided to return.
    return 'upstream_unavailable';
  }
  return 'upstream_error';
}

/**
 * POST a JSON body and read the `{ data }` envelope.
 *
 * `parse` is the caller's runtime validation of the payload — a zod schema's
 * `safeParse`, applied at this boundary because "the API is ours" is a statement
 * about intent, not about what a rolling deploy is currently serving. A payload
 * that does not parse is reported as `upstream_contract`, never coerced.
 */
export async function apiPost<T>(
  env: HubEnv,
  path: string,
  body: unknown,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
  bearer?: string
): Promise<UpstreamResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl(env)}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 502, code: 'upstream_unavailable' };
  }

  if (!response.ok) {
    return { ok: false, status: response.status, code: await readError(response) };
  }

  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch {
    return { ok: false, status: 502, code: 'upstream_contract' };
  }

  const payload =
    typeof envelope === 'object' && envelope !== null && 'data' in envelope
      ? (envelope as { data: unknown }).data
      : undefined;
  const parsed = parse(payload);
  if (!parsed.success) {
    return { ok: false, status: 502, code: 'upstream_contract' };
  }
  return { ok: true, data: parsed.data };
}

/** GET with a bearer, same envelope and same validation contract as {@link apiPost}. */
export async function apiGet<T>(
  env: HubEnv,
  path: string,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
  bearer: string
): Promise<UpstreamResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl(env)}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}` },
    });
  } catch {
    return { ok: false, status: 502, code: 'upstream_unavailable' };
  }

  if (!response.ok) {
    return { ok: false, status: response.status, code: await readError(response) };
  }

  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch {
    return { ok: false, status: 502, code: 'upstream_contract' };
  }

  const payload =
    typeof envelope === 'object' && envelope !== null && 'data' in envelope
      ? (envelope as { data: unknown }).data
      : undefined;
  const parsed = parse(payload);
  if (!parsed.success) {
    return { ok: false, status: 502, code: 'upstream_contract' };
  }
  return { ok: true, data: parsed.data };
}
