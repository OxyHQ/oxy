import {
  buildIdentityLinkQrPayload,
  identityLinkProofRequestSchema,
  parseIdentityLinkQrPayload,
} from '../identityLink';

const LINK_ID = 'ab'.repeat(16);
const CHALLENGE = 'cd'.repeat(32);

describe('the Commons link QR', () => {
  it('round-trips the link id and the challenge', () => {
    const payload = buildIdentityLinkQrPayload(LINK_ID, CHALLENGE);
    expect(payload).toBe(`oxycommons://link?id=${LINK_ID}&c=${CHALLENGE}`);
    expect(parseIdentityLinkQrPayload(`  ${payload} `)).toEqual({ linkId: LINK_ID, challenge: CHALLENGE });
  });

  it.each([
    ['another scheme', `https://auth.oxy.so/link?id=${LINK_ID}&c=${CHALLENGE}`],
    ['a sign-in QR', 'oxycommons://approve?code=abc'],
    ['a short link id', `oxycommons://link?id=abc&c=${CHALLENGE}`],
    ['no challenge', `oxycommons://link?id=${LINK_ID}`],
    ['an uppercase challenge', `oxycommons://link?id=${LINK_ID}&c=${CHALLENGE.toUpperCase()}`],
  ])('refuses %s', (_label, raw) => {
    expect(parseIdentityLinkQrPayload(raw)).toBeNull();
  });

  it('takes a canonical uncompressed key with its proof, and nothing else', () => {
    const proof = { v: 2, challenge: CHALLENGE, expiresAt: 1_900_000_000_000, signature: 'sig' };
    expect(identityLinkProofRequestSchema.parse({ publicKey: `04${'A'.repeat(128)}`, proof }).publicKey).toBe(`04${'a'.repeat(128)}`);
    expect(identityLinkProofRequestSchema.safeParse({ publicKey: `02${'a'.repeat(64)}`, proof }).success).toBe(false);
    expect(identityLinkProofRequestSchema.safeParse({ publicKey: `04${'a'.repeat(128)}`, proof, userId: 'x' }).success).toBe(false);
  });
});
