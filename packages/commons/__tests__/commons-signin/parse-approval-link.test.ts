import { parseApprovalLink } from '@/lib/commons-signin/parse-approval-link';

describe('parseApprovalLink', () => {
  const future = () => Date.now() + 5 * 60 * 1000;
  const past = () => Date.now() - 60 * 1000;

  describe('valid payloads', () => {
    it('extracts the code from a full oxycommons:// payload', () => {
      const url = `oxycommons://approve?v=1&code=ABC123&app=oxy_dk_x&origin=https%3A%2F%2Frp.example&nonce=n1&exp=${future()}`;
      expect(parseApprovalLink(url)).toEqual({ ok: true, code: 'ABC123' });
    });

    it('accepts the commons:// app scheme', () => {
      expect(parseApprovalLink('commons://approve?code=XYZ&v=1')).toEqual({
        ok: true,
        code: 'XYZ',
      });
    });

    it('accepts the https://commons.oxy.so universal link', () => {
      expect(parseApprovalLink('https://commons.oxy.so/approve?code=zzz')).toEqual({
        ok: true,
        code: 'zzz',
      });
    });

    it('url-decodes a percent-encoded code', () => {
      expect(parseApprovalLink('oxycommons://approve?code=a%2Fb%2Bc')).toEqual({
        ok: true,
        code: 'a/b+c',
      });
    });

    it('treats a future exp as not expired', () => {
      expect(parseApprovalLink(`oxycommons://approve?code=ok&exp=${future()}`)).toEqual({
        ok: true,
        code: 'ok',
      });
    });

    it('ignores a non-numeric exp (server expiry is authoritative)', () => {
      expect(parseApprovalLink('oxycommons://approve?code=ok&exp=notanumber')).toEqual({
        ok: true,
        code: 'ok',
      });
    });
  });

  describe('expired payloads', () => {
    it('rejects a payload whose exp is in the past', () => {
      expect(parseApprovalLink(`oxycommons://approve?code=ABC&exp=${past()}`)).toEqual({
        ok: false,
        reason: 'expired',
      });
    });
  });

  describe('invalid payloads', () => {
    it('rejects an empty string', () => {
      expect(parseApprovalLink('')).toEqual({ ok: false, reason: 'invalid' });
    });

    it('rejects a non-approve scheme/host', () => {
      expect(parseApprovalLink('oxycommons://something?code=ABC')).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('rejects an unrelated deep link', () => {
      expect(parseApprovalLink('https://example.com/approve?code=ABC')).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('rejects an approve link with no code', () => {
      expect(parseApprovalLink('oxycommons://approve?v=1&app=oxy_dk_x')).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('rejects an approve link with an empty code', () => {
      expect(parseApprovalLink('oxycommons://approve?code=')).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('rejects a plain token string (no scheme)', () => {
      expect(parseApprovalLink('ABC123')).toEqual({ ok: false, reason: 'invalid' });
    });
  });
});
