import { redirectSystemPath } from '@/app/+native-intent';
import { parseScan } from '@/lib/commons-signin/parse-scan';

const DID = 'did:web:oxy.so:u:65f0abc123';
const ENCODED = encodeURIComponent(DID);

function redirect(path: string): string {
  return redirectSystemPath({ path, initial: true });
}

describe('redirectSystemPath — card deep link', () => {
  it('rewrites a scheme-stripped card query link to the path-param route', () => {
    expect(redirect(`/card?did=${DID}&v=1`)).toBe(`/card/${ENCODED}`);
  });

  it('handles the various shapes the OS can hand back (scheme / no leading slash)', () => {
    // No leading slash.
    expect(redirect(`card?did=${DID}&v=1`)).toBe(`/card/${ENCODED}`);
    // Full commons scheme not stripped.
    expect(redirect(`commons://card?did=${DID}&v=1`)).toBe(`/card/${ENCODED}`);
    // Full oxycommons scheme not stripped.
    expect(redirect(`oxycommons://card?did=${DID}&v=1`)).toBe(`/card/${ENCODED}`);
    // Ordering of query params must not matter.
    expect(redirect(`/card?v=1&did=${DID}`)).toBe(`/card/${ENCODED}`);
  });

  it('produces the SAME did→route mapping as an in-app card scan', () => {
    // The scanner branch: parseScan → routeParsed navigates to
    // `/(tabs)/(id)/card/[did]` with `params.did = <full DID>`. The deep-link
    // rewrite must resolve to the identical `/card/<did>` with the identical
    // decoded param.
    const scanned = parseScan(`oxycommons://card?did=${DID}&v=1`);
    expect(scanned).toEqual({ kind: 'id', did: DID });

    const redirected = redirect(`/card?did=${DID}&v=1`);
    const lastSegment = redirected.split('/').pop() ?? '';
    expect(decodeURIComponent(lastSegment)).toBe(scanned.kind === 'id' ? scanned.did : '');
  });

  it('passes unrelated paths through untouched', () => {
    // The attest leaf route already matches the query form directly.
    expect(redirect('/attest?subject=did:web:oxy.so:u:x&ctx=c&nonce=n&exp=1')).toBe(
      '/attest?subject=did:web:oxy.so:u:x&ctx=c&nonce=n&exp=1',
    );
    // The approval leaf route.
    expect(redirect('/approve?code=abc123')).toBe('/approve?code=abc123');
    // An ordinary in-app path.
    expect(redirect('/(tabs)/(id)')).toBe('/(tabs)/(id)');
  });

  it('passes malformed / did-less card links through so the normal not-found shows', () => {
    // No query at all.
    expect(redirect('/card')).toBe('/card');
    // Present-but-empty did.
    expect(redirect('/card?did=')).toBe('/card?did=');
    // Wrong param.
    expect(redirect('/card?foo=bar')).toBe('/card?foo=bar');
    // Empty path.
    expect(redirect('')).toBe('');
  });

  it('sends a link QR scanned with the system camera to the link confirmation (ADR 0029 D3)', () => {
    const linkId = 'ab'.repeat(16);
    const challenge = 'cd'.repeat(32);
    expect(redirect(`/link?id=${linkId}&c=${challenge}`)).toBe(`/link-account/confirm?id=${linkId}&c=${challenge}`);
    expect(redirect(`oxycommons://link?id=${linkId}&c=${challenge}`)).toBe(`/link-account/confirm?id=${linkId}&c=${challenge}`);
    // Anything that is not a whole link payload passes through.
    expect(redirect('/link?id=nope')).toBe('/link?id=nope');
  });
});
