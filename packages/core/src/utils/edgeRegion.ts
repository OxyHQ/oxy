const EDGE_REGION_HEADER = 'X-Oxy-Edge-Region';
const EDGE_REGION_PATTERN = /^[a-z]{3}$/i;
const TRACE_TIMEOUT_MS = 1_000;

let browserEdgeRegionPromise: Promise<string | null> | null = null;

function canDiscoverBrowserEdgeRegion(): boolean {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return false;
  const { hostname, protocol } = window.location;
  return (protocol === 'https:' || protocol === 'http:')
    && hostname !== 'localhost'
    && hostname !== '127.0.0.1'
    && hostname !== '[::1]';
}

async function discoverBrowserEdgeRegion(): Promise<string | null> {
  if (!canDiscoverBrowserEdgeRegion()) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRACE_TIMEOUT_MS);
  try {
    const response = await fetch('/cdn-cgi/trace', {
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!response.ok) return null;

    // Deliberately extract only Cloudflare's three-letter serving PoP. The
    // trace response also contains connection metadata; none of it is stored,
    // logged, returned, or attached to an Oxy request.
    const match = (await response.text()).match(/^colo=([a-z]{3})$/im);
    return match && EDGE_REGION_PATTERN.test(match[1]) ? match[1].toLowerCase() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getBrowserEdgeRegionHeader(): Promise<Record<string, string>> {
  browserEdgeRegionPromise ??= discoverBrowserEdgeRegion();
  const region = await browserEdgeRegionPromise;
  return region ? { [EDGE_REGION_HEADER]: region } : {};
}

