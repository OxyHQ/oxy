import { parseScan } from '@/lib/commons-signin/parse-scan';

describe('parseScan', () => {
  const future = () => Date.now() + 5 * 60 * 1000;
  const past = () => Date.now() - 60 * 1000;

  describe('approval links', () => {
    it('branches a valid approval link to { kind: approval }', () => {
      const url = `oxycommons://approve?v=1&code=ABC123&app=oxy_dk_x&exp=${future()}`;
      expect(parseScan(url)).toEqual({ kind: 'approval', code: 'ABC123' });
    });

    it('accepts the commons:// app scheme', () => {
      expect(parseScan('commons://approve?code=XYZ')).toEqual({ kind: 'approval', code: 'XYZ' });
    });

    it('surfaces an expired approval link as expired (not invalid, not id)', () => {
      expect(parseScan(`oxycommons://approve?code=ABC&exp=${past()}`)).toEqual({
        kind: 'invalid',
        reason: 'expired',
      });
    });

    it('treats an approve link with no code as invalid', () => {
      expect(parseScan('oxycommons://approve?v=1')).toEqual({ kind: 'invalid', reason: 'invalid' });
    });
  });

  describe('Oxy ID cards', () => {
    it('branches a valid Oxy ID payload to { kind: id } carrying the DID', () => {
      const did = 'did:web:oxy.so:u:65f0abc123';
      expect(parseScan(`oxycommons://card?did=${did}&v=1`)).toEqual({ kind: 'id', did });
    });

    it('url-decodes a percent-encoded DID', () => {
      const encoded = encodeURIComponent('did:web:oxy.so:u:65f0abc123');
      expect(parseScan(`oxycommons://card?did=${encoded}`)).toEqual({
        kind: 'id',
        did: 'did:web:oxy.so:u:65f0abc123',
      });
    });

    it('treats an Oxy ID card with no did as invalid', () => {
      expect(parseScan('oxycommons://card?v=1')).toEqual({ kind: 'invalid', reason: 'invalid' });
    });
  });

  describe('attest requests', () => {
    const future = () => Date.now() + 5 * 60 * 1000;

    it('branches a valid attest payload to { kind: attest } carrying the fields', () => {
      const exp = future();
      const did = 'did:web:oxy.so:u:65f0abc123';
      expect(parseScan(`oxycommons://attest?subject=${did}&ctx=meet&nonce=n1&exp=${exp}`)).toEqual({
        kind: 'attest',
        subjectDid: did,
        context: 'meet',
        nonce: 'n1',
        exp,
      });
    });

    it('defaults context to empty string when ctx is omitted', () => {
      const exp = future();
      const result = parseScan(
        `oxycommons://attest?subject=did:web:oxy.so:u:x&nonce=n2&exp=${exp}`,
      );
      expect(result).toEqual({
        kind: 'attest',
        subjectDid: 'did:web:oxy.so:u:x',
        context: '',
        nonce: 'n2',
        exp,
      });
    });

    it('treats an attest payload missing nonce/exp as invalid', () => {
      expect(parseScan('oxycommons://attest?subject=did:web:oxy.so:u:x')).toEqual({
        kind: 'invalid',
        reason: 'invalid',
      });
    });

    it('surfaces an expired attest payload as expired', () => {
      expect(
        parseScan(`oxycommons://attest?subject=did:web:oxy.so:u:x&nonce=n3&exp=${past()}`),
      ).toEqual({
        kind: 'invalid',
        reason: 'expired',
      });
    });

    it('does not confuse an Oxy ID card with an attest request', () => {
      expect(parseScan('oxycommons://card?did=did:web:oxy.so:u:x').kind).toBe('id');
    });
  });

  describe('unrelated input', () => {
    it('rejects an empty string', () => {
      expect(parseScan('')).toEqual({ kind: 'invalid', reason: 'invalid' });
    });

    it('rejects a plain token string', () => {
      expect(parseScan('ABC123')).toEqual({ kind: 'invalid', reason: 'invalid' });
    });

    it('rejects an unrelated deep link', () => {
      expect(parseScan('https://example.com/card?did=x')).toEqual({
        kind: 'invalid',
        reason: 'invalid',
      });
    });

    it('rejects a non-approve / non-card oxy scheme', () => {
      expect(parseScan('oxycommons://something?code=ABC')).toEqual({
        kind: 'invalid',
        reason: 'invalid',
      });
    });
  });
});
