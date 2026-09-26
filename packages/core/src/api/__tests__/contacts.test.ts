import { stubbedClient } from './helpers';

describe('oxy.contacts', () => {
  it('posts the hashes and returns the matches', async () => {
    const { oxy, request } = stubbedClient('me');
    const res = { matches: [{ userId: 'u', hashedIdentifier: 'h', matchType: 'email' }] };
    request.mockResolvedValue(res);
    await expect(oxy.contacts.discover(['h'], [])).resolves.toBe(res);
    expect(request).toHaveBeenCalledWith('POST', '/contacts/discover', { hashedEmails: ['h'], hashedPhones: [] }, { cache: false });
  });
});
