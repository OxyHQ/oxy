/**
 * The logger writes no credential-shaped FIELD VALUE (#972 section 12, "no
 * upstream provider key in logs, traces, metrics, errors or API responses").
 *
 * ## What this measures, and what it deliberately does not claim
 *
 * It captures what the real `logger` singleton actually writes to stdout —
 * through the real pino instance, with the real `redact` configuration — and
 * asserts the censor appears where a secret was and the secret does not.
 *
 * It is NOT a claim that a credential cannot reach a log. `utils/logger.ts` says
 * why at length: this is a floor over field NAMES at one level of nesting, while
 * the actual control for a BYOK credential is `ProviderSecretValue`'s private
 * `#value` and its three overridden serialisers. A test that asserted "no secret
 * can be logged" would be asserting something no path-based redaction can
 * deliver.
 *
 * ## The positive control is the whole reason this file can fail usefully
 *
 * A redaction test passes trivially against a logger that writes NOTHING: the
 * secret is absent from an empty haystack. So every case below also asserts that
 * a field which is NOT on the list survives verbatim in the same line. If that
 * assertion ever fails, the run is measuring a broken logger rather than a
 * working redactor — and the two are indistinguishable from the negative
 * assertion alone.
 *
 * ## `NODE_ENV` is PINNED before the logger is imported, and that is not optional
 *
 * `utils/logger.ts` reads `NODE_ENV` at module load and, in `development`, sends
 * pino through the `pino-pretty` TRANSPORT — a worker thread whose output leaves
 * this process entirely. So under `development` this file captures an empty array
 * and every negative assertion becomes trivially true.
 *
 * That is not hypothetical. `process.env` is shared across every file a jest
 * worker runs, and three sibling suites set `NODE_ENV = 'development'` and do not
 * restore it (`middleware/__tests__/errorHandler.test.ts`,
 * `middleware/__tests__/originGuard.test.ts`, `config/__tests__/env.test.ts`).
 * Measured: green in isolation, all eighteen cases red in the full run.
 *
 * So the value is set BEFORE the module is loaded — which is why the import is
 * dynamic, since a static one is hoisted above every statement in the file.
 *
 * ## The DESTINATION is substituted; nothing about fd 1 is intercepted
 *
 * pino is wrapped, not mocked: the factory below calls the REAL pino with the
 * REAL options `utils/logger.ts` passes it, and supplies a destination this file
 * owns. So the redaction engine, the option object and the wrapper's own
 * `error()` merging are all the production ones — only where the bytes land
 * changes.
 *
 * Intercepting `process.stdout.write` was tried first and is NOT reliable here.
 * jest runs a single test file IN BAND and a full run in a forked WORKER, and
 * pino's default destination does not reach fd 1 the same way in both: the
 * interception captured every line in isolation and NOTHING in the full run, so
 * all eighteen cases were green alone and red together. Substituting the
 * destination removes the question entirely.
 *
 * The vacuity floor in every case (`expect(lines).toHaveLength(1)`) is what makes
 * a regression in any of this loud instead of silent: with nothing captured, every
 * "the secret does not appear" assertion is trivially true.
 */

/**
 * Every line the wrapped pino wrote, newest last. Cleared before each case.
 *
 * Declared here and closed over by the factory below. The factory does not run
 * until `pino` is first required, which is inside the dynamic import in
 * `beforeAll` — after this initialiser.
 */
const written: string[] = [];

jest.mock('pino', () => {
  const actual = jest.requireActual('pino') as typeof import('pino');
  type PinoOptions = Parameters<typeof actual.default>[0];
  const wrapped = (options: PinoOptions) =>
    actual.default(options, {
      write(chunk: string): void {
        written.push(chunk);
      },
    });
  return { __esModule: true, default: wrapped };
});

/** Bound in `beforeAll`, after `NODE_ENV` is pinned. See the header. */
let logger: (typeof import('../logger'))['logger'];

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  ({ logger } = await import('../logger'));
});

afterAll(() => {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

beforeEach(() => {
  written.length = 0;
});

/** One captured log line, parsed. */
interface CapturedLine {
  readonly raw: string;
  readonly json: Record<string, unknown>;
}

/**
 * Run `emit` and return the lines pino wrote that carry `message`.
 *
 * Filtered on the message rather than taken wholesale, so a line some other code
 * logged inside the same call cannot be read as the one under test.
 */
function capture(emit: () => void, message: string): CapturedLine[] {
  emit();
  return written
    .join('')
    .split('\n')
    .filter((line) => line.includes(message))
    .map((raw) => ({ raw, json: JSON.parse(raw) as Record<string, unknown> }));
}

const CENSOR = '[redacted]';

/** A distinctive value, so finding it anywhere is unambiguous. */
function secret(name: string): string {
  return `LEAKED-${name}-9f2b7c1d`;
}

/** The field that must NOT be redacted, in every case. The positive control. */
const CONTROL_VALUE = 'SURVIVES-VERBATIM-5a1c';

describe('the logger redacts credential-shaped field names', () => {
  it.each([
    ['authorization'],
    ['apiKey'],
    ['api_key'],
    ['secret'],
    ['token'],
    ['accessToken'],
    ['refreshToken'],
    ['deviceSecret'],
    ['clientSecret'],
    ['password'],
  ])('censors a top-level %s', (field) => {
    const value = secret(field);

    const lines = capture(() => {
      logger.info('redaction probe', { [field]: value, requestId: CONTROL_VALUE });
    }, 'redaction probe');

    // VACUITY FLOOR: nothing captured means the assertions below are about an
    // empty string, which every redactor and every broken logger satisfies.
    expect(lines).toHaveLength(1);
    expect(lines[0].raw).not.toContain(value);
    expect(lines[0].json[field]).toBe(CENSOR);
    // POSITIVE CONTROL: an unlisted field on the SAME line is untouched, so the
    // absence above is redaction and not a logger that dropped the context.
    expect(lines[0].json.requestId).toBe(CONTROL_VALUE);
    expect(lines[0].raw).toContain('redaction probe');
  });

  it.each([['authorization'], ['token'], ['secret'], ['deviceSecret'], ['clientSecret']])(
    'censors a nested %s one level down',
    (field) => {
      const value = secret(`nested-${field}`);

      const lines = capture(() => {
        logger.warn('nested redaction probe', {
          upstream: { [field]: value, provider: CONTROL_VALUE },
        });
      }, 'nested redaction probe');

      expect(lines).toHaveLength(1);
      expect(lines[0].raw).not.toContain(value);
      const upstream = lines[0].json.upstream as Record<string, unknown>;
      expect(upstream[field]).toBe(CENSOR);
      expect(upstream.provider).toBe(CONTROL_VALUE);
    }
  );

  it('censors the two request headers a middleware would log', () => {
    const bearer = secret('req-authorization');
    const cookie = secret('req-cookie');

    const lines = capture(() => {
      logger.info('request probe', {
        req: {
          headers: { authorization: bearer, cookie, 'user-agent': CONTROL_VALUE },
        },
      });
    }, 'request probe');

    expect(lines).toHaveLength(1);
    expect(lines[0].raw).not.toContain(bearer);
    expect(lines[0].raw).not.toContain(cookie);
    const headers = (lines[0].json.req as { headers: Record<string, unknown> }).headers;
    expect(headers.authorization).toBe(CENSOR);
    expect(headers.cookie).toBe(CENSOR);
    expect(headers['user-agent']).toBe(CONTROL_VALUE);
  });

  it('censors a credential merged in through the error arm', () => {
    const value = secret('error-token');

    const lines = capture(() => {
      // The non-`Error` branch of `logger.error` merges the object's own keys
      // into the line, which is the shape a rejected upstream response takes.
      logger.error('error probe', { token: value, code: CONTROL_VALUE });
    }, 'error probe');

    expect(lines).toHaveLength(1);
    expect(lines[0].raw).not.toContain(value);
    expect(lines[0].json.token).toBe(CENSOR);
    expect(lines[0].json.code).toBe(CONTROL_VALUE);
  });

  /**
   * The limit, asserted rather than left for somebody to assume away.
   *
   * `*.token` is one level. This case documents that a secret two levels down is
   * NOT redacted, so nobody reads the cases above as "the logger cannot leak a
   * credential" — which is the belief that makes a floor dangerous.
   */
  it('does NOT reach two levels down, which is why this is a floor and not the control', () => {
    const value = secret('deep');

    const lines = capture(() => {
      logger.info('depth probe', { outer: { inner: { token: value } } });
    }, 'depth probe');

    expect(lines).toHaveLength(1);
    expect(lines[0].raw).toContain(value);
  });
});
