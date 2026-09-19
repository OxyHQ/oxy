/**
 * Relay list parsing.
 *
 * `SMTP_RELAY_HOST` accepts a comma-separated list so a deployment can name a
 * primary and one or more fallbacks. The failure this covers is the one this
 * platform actually hit: a single relay decided it would not carry the traffic
 * and outbound mail stopped, with no second path and no way to add one without
 * a code change.
 *
 * The parser is re-imported per test because it reads `process.env` at call
 * time through `getEnvVar`.
 */

function parse(env: Record<string, string | undefined>) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('../email.config') as typeof import('../email.config')).parseRelayList();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('parseRelayList', () => {
  it('is empty when no relay is configured — the state that refuses every send', () => {
    expect(parse({ SMTP_RELAY_HOST: '', SMTP_RELAY_USER: '', SMTP_RELAY_PASS: '' })).toEqual([]);
  });

  it('reads a single relay exactly as it always did', () => {
    expect(
      parse({
        SMTP_RELAY_HOST: 'smtp-relay.brevo.com',
        SMTP_RELAY_PORT: '587',
        SMTP_RELAY_USER: 'user@example.com',
        SMTP_RELAY_PASS: 'secret',
      }),
    ).toEqual([
      { name: 'smtp-relay.brevo.com', host: 'smtp-relay.brevo.com', port: 587, user: 'user@example.com', pass: 'secret' },
    ]);
  });

  it('aligns several relays by position', () => {
    expect(
      parse({
        SMTP_RELAY_HOST: 'primary.example.com, fallback.example.com',
        SMTP_RELAY_PORT: '587,2525',
        SMTP_RELAY_USER: 'first,second',
        SMTP_RELAY_PASS: 'pw1,pw2',
      }),
    ).toEqual([
      { name: 'primary.example.com', host: 'primary.example.com', port: 587, user: 'first', pass: 'pw1' },
      { name: 'fallback.example.com', host: 'fallback.example.com', port: 2525, user: 'second', pass: 'pw2' },
    ]);
  });

  it('reuses a single port/user/pass across every relay', () => {
    const relays = parse({
      SMTP_RELAY_HOST: 'a.example.com,b.example.com',
      SMTP_RELAY_PORT: '2525',
      SMTP_RELAY_USER: 'shared',
      SMTP_RELAY_PASS: 'shared-pw',
    });
    expect(relays.map((r) => [r.port, r.user, r.pass])).toEqual([
      [2525, 'shared', 'shared-pw'],
      [2525, 'shared', 'shared-pw'],
    ]);
  });

  it('ignores blank entries and surrounding whitespace', () => {
    expect(parse({ SMTP_RELAY_HOST: ' a.example.com , , b.example.com ', SMTP_RELAY_USER: '', SMTP_RELAY_PASS: '' })
      .map((r) => r.host)).toEqual(['a.example.com', 'b.example.com']);
  });

  it('falls back to 587 for a port that is not a number', () => {
    expect(parse({ SMTP_RELAY_HOST: 'a.example.com', SMTP_RELAY_PORT: 'nonsense', SMTP_RELAY_USER: '', SMTP_RELAY_PASS: '' })[0].port)
      .toBe(587);
  });
});
