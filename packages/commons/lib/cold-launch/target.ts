import { parseIdPayload } from '@oxy.so/core/civic';

/**
 * What a cold-launching system deep link asks Commons to open.
 *
 * A typed expo-router `Href` in its object form: `typedRoutes` is on, and a
 * runtime-built string cannot narrow to the generated path union.
 *
 * - `approve` (`oxycommons://approve?…`) is a ROOT `transparentModal` route.
 * - `attest` (`oxycommons://attest?…`) lives in the `(scan)` group.
 * - `card` (`oxycommons://card?did=…&v=1`, a shared Oxy ID) is the `(tabs)`
 *   route `/(tabs)/(id)/card/[did]`, the screen an in-app scan opens.
 *
 * On a COLD start every one of these is inside a guard that is closed while the
 * routing gate is still `checking`, so expo-router bounces the URL and it is
 * lost; `app/_layout.tsx` captures it with this function and replays it once
 * the gate settles to a signed-in device. A card used to be left out of that
 * replay ("+native-intent rewrites it"), but the rewrite only reaches a router
 * that can show it: cold-launching a card link opened the ID tab and dropped
 * the card.
 */
export type ColdLaunchTarget =
  | { pathname: '/approve'; params: Record<string, string> }
  | { pathname: '/(scan)/attest'; params: Record<string, string> }
  | { pathname: '/(tabs)/(id)/card/[did]'; params: { did: string } };

function stripScheme(url: string): string {
  return url
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^\/+/, '');
}

function decodeQuery(query: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1);
    try {
      params[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
    } catch {
      // A malformed percent-sequence in a scanned/tapped payload: keep the raw
      // bytes for this param rather than dropping the whole intent; the target
      // screen validates its params and rejects anything unusable.
      params[rawKey] = rawValue;
    }
  }
  return params;
}

/** The target of a cold-launch deep link, or `null` when it is not one Commons replays. */
export function coldLaunchTargetFromUrl(url: string): ColdLaunchTarget | null {
  const stripped = stripScheme(url);
  const [pathPart, query = ''] = stripped.split(/[?#]/);
  const segment = pathPart.toLowerCase();

  if (segment === 'approve') {
    return { pathname: '/approve', params: decodeQuery(query) };
  }
  if (segment === 'attest') {
    return { pathname: '/(scan)/attest', params: decodeQuery(query) };
  }
  if (segment === 'card' || segment.startsWith('card/')) {
    // The same validation the scanner and `+native-intent` use, on the
    // canonical `oxycommons://card?…` form. `card/<did>` is the already
    // rewritten path form.
    const did = segment.startsWith('card/')
      ? safeDecode(pathPart.slice('card/'.length))
      : (parseIdPayload(`oxycommons://${stripped}`)?.did ?? null);
    return did ? { pathname: '/(tabs)/(id)/card/[did]', params: { did } } : null;
  }
  return null;
}

function safeDecode(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}
