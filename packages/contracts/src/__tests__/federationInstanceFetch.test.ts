import { instanceFetchSignRequestSchema, instanceFetchSignResponseSchema } from '../index';

describe('instance-fetch signing contract', () => {
  it('takes a URL and nothing that could become a signing string', () => {
    expect(instanceFetchSignRequestSchema.safeParse({ url: 'https://mastodon.example/users/ada/outbox' }).success).toBe(true);
    expect(instanceFetchSignRequestSchema.safeParse({ url: 'https://m.example/', signingString: 'x' }).success).toBe(false);
    expect(instanceFetchSignRequestSchema.safeParse({ url: 'https://m.example/', method: 'POST' }).success).toBe(false);
    expect(instanceFetchSignRequestSchema.safeParse({ url: `https://m.example/${'a'.repeat(2048)}` }).success).toBe(false);
  });

  it('answers with the keyId and exactly the three headers to send', () => {
    const ok = {
      keyId: 'https://oxy.so/ap/users/instance#main-key',
      headers: { Host: 'mastodon.example', Date: 'Sat, 26 Sep 2026 00:00:00 GMT', Signature: 'keyId="…"' },
    };
    expect(instanceFetchSignResponseSchema.safeParse(ok).success).toBe(true);
    expect(instanceFetchSignResponseSchema.safeParse({ ...ok, headers: { ...ok.headers, Digest: 'x' } }).success).toBe(false);
  });
});
