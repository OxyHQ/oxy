import { deriveIdentityLinkCode } from '../identityLink';

const LINK_ID = 'ab'.repeat(16);
const KEY = `04${'1f'.repeat(64)}`;

describe('deriveIdentityLinkCode', () => {
  it('is 6 digits, the same on both devices whatever the key spelling', () => {
    const code = deriveIdentityLinkCode(LINK_ID, KEY);
    expect(code).toMatch(/^\d{6}$/);
    expect(deriveIdentityLinkCode(LINK_ID, ` ${KEY.toUpperCase()} `)).toBe(code);
  });

  it('changes with the key and with the request', () => {
    const code = deriveIdentityLinkCode(LINK_ID, KEY);
    expect(deriveIdentityLinkCode(LINK_ID, `04${'2e'.repeat(64)}`)).not.toBe(code);
    expect(deriveIdentityLinkCode('cd'.repeat(16), KEY)).not.toBe(code);
  });
});
