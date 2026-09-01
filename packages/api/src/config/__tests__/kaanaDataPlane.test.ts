/**
 * The data-plane configuration, and the one property that makes shipping it safe
 * (issue #972 workstream 4, ADR 0015).
 *
 * ## The test this file exists for
 *
 * **Absent configuration must resolve to `absent`, and a PARTIAL configuration
 * must resolve to `unreadable` rather than to something usable.** The first is
 * what keeps every deployment today byte-for-byte unchanged; the second is what
 * stops a base URL with no signing key from producing unsigned envelopes that the
 * data plane refuses one by one, which presents as a data-plane outage rather
 * than as a missing variable.
 *
 * Every case sets the three variables explicitly and restores them afterwards, so
 * an ambient `KAANA_*` in a developer's environment cannot make an assertion pass
 * or fail for a reason this file does not name.
 */

import { generateKeyPairSync } from 'node:crypto';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import {
  KAANA_BASE_URL_VARIABLE,
  KAANA_SIGNING_KEY_ID_VARIABLE,
  KAANA_SIGNING_PRIVATE_KEY_VARIABLE,
  kaanaPublicKeyBase64,
  resolveKaanaDataPlane,
} from '../kaanaDataPlane';
import { logger } from '../../utils/logger';

const mockedLogger = logger as jest.Mocked<typeof logger>;

const VARIABLES = [
  KAANA_BASE_URL_VARIABLE,
  KAANA_SIGNING_KEY_ID_VARIABLE,
  KAANA_SIGNING_PRIVATE_KEY_VARIABLE,
] as const;

const ORIGINAL = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));

/** A real Ed25519 pair, so nothing here asserts against a hand-written blob. */
const edgeKey = generateKeyPairSync('ed25519');
const EDGE_PRIVATE_PEM = edgeKey.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

function configure(values: Partial<Record<(typeof VARIABLES)[number], string>>): void {
  for (const name of VARIABLES) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

const COMPLETE = {
  [KAANA_BASE_URL_VARIABLE]: 'https://kaana.internal',
  [KAANA_SIGNING_KEY_ID_VARIABLE]: 'oxy-edge-2026-08',
  [KAANA_SIGNING_PRIVATE_KEY_VARIABLE]: EDGE_PRIVATE_PEM,
} as const;

beforeEach(() => {
  jest.clearAllMocks();
});

afterAll(() => {
  for (const [name, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('an unconfigured deployment', () => {
  it('resolves absent, silently, when none of the three variables is set', () => {
    configure({});

    expect(resolveKaanaDataPlane()).toEqual({ status: 'absent' });
    // Silently: this is the DEFAULT state of every deployment, and an error line
    // per boot would train an operator to ignore the one that matters.
    expect(mockedLogger.error).not.toHaveBeenCalled();
  });

  it('treats an empty string exactly as unset, rather than as a base URL', () => {
    configure({
      [KAANA_BASE_URL_VARIABLE]: '   ',
      [KAANA_SIGNING_KEY_ID_VARIABLE]: '',
      [KAANA_SIGNING_PRIVATE_KEY_VARIABLE]: '',
    });

    expect(resolveKaanaDataPlane()).toEqual({ status: 'absent' });
  });
});

describe('a partial configuration is refused, loudly', () => {
  it('refuses a base URL with no signing key, rather than forwarding unsigned', () => {
    configure({ [KAANA_BASE_URL_VARIABLE]: COMPLETE[KAANA_BASE_URL_VARIABLE] });

    const resolution = resolveKaanaDataPlane();
    expect(resolution.status).toBe('unreadable');
    expect(resolution).toMatchObject({ variable: KAANA_SIGNING_KEY_ID_VARIABLE });
    expect(mockedLogger.error).toHaveBeenCalledWith(
      'inference.kaana.config_unreadable',
      expect.any(Error),
      expect.objectContaining({ variable: KAANA_SIGNING_KEY_ID_VARIABLE })
    );
  });

  it('refuses a signing key with no base URL', () => {
    configure({
      [KAANA_SIGNING_KEY_ID_VARIABLE]: COMPLETE[KAANA_SIGNING_KEY_ID_VARIABLE],
      [KAANA_SIGNING_PRIVATE_KEY_VARIABLE]: EDGE_PRIVATE_PEM,
    });

    expect(resolveKaanaDataPlane()).toMatchObject({
      status: 'unreadable',
      variable: KAANA_BASE_URL_VARIABLE,
    });
  });

  it('never puts the value in the log — one of the three is a private key', () => {
    configure({ ...COMPLETE, [KAANA_BASE_URL_VARIABLE]: 'not-a-url' });

    expect(resolveKaanaDataPlane().status).toBe('unreadable');
    const serialized = JSON.stringify(mockedLogger.error.mock.calls);
    expect(serialized).not.toContain('not-a-url');
    expect(serialized).not.toContain('PRIVATE KEY');
    // POSITIVE CONTROL on the search: what the log DOES carry is found the same
    // way, so the two absences above are real absences and not an unreadable
    // haystack.
    expect(serialized).toContain(KAANA_BASE_URL_VARIABLE);
  });
});

describe('a key this build cannot sign with is refused at resolution', () => {
  it('refuses an RSA key, which would sign happily and be rejected on every request', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    configure({
      ...COMPLETE,
      [KAANA_SIGNING_PRIVATE_KEY_VARIABLE]: rsa.privateKey
        .export({ format: 'pem', type: 'pkcs8' })
        .toString(),
    });

    expect(resolveKaanaDataPlane()).toMatchObject({
      status: 'unreadable',
      variable: KAANA_SIGNING_PRIVATE_KEY_VARIABLE,
    });
  });

  it('refuses text that is neither a PEM nor base64 of one', () => {
    configure({ ...COMPLETE, [KAANA_SIGNING_PRIVATE_KEY_VARIABLE]: 'hunter2' });

    expect(resolveKaanaDataPlane()).toMatchObject({
      status: 'unreadable',
      variable: KAANA_SIGNING_PRIVATE_KEY_VARIABLE,
    });
  });

  it('refuses a key id carrying a separator the data plane parses its key set on', () => {
    // `kid:base64,kid:base64` — a key id with a colon is one the data plane could
    // never be configured with, so it is refused here rather than becoming a
    // signature nothing can verify.
    for (const keyId of ['oxy:edge', 'oxy,edge', 'oxy edge', 'oxy\nedge']) {
      configure({ ...COMPLETE, [KAANA_SIGNING_KEY_ID_VARIABLE]: keyId });
      expect(resolveKaanaDataPlane()).toMatchObject({
        status: 'unreadable',
        variable: KAANA_SIGNING_KEY_ID_VARIABLE,
      });
    }
  });
});

describe('a complete configuration', () => {
  it('resolves an Ed25519 key and normalizes the base URL', () => {
    configure({ ...COMPLETE, [KAANA_BASE_URL_VARIABLE]: 'https://kaana.internal/' });

    const resolution = resolveKaanaDataPlane();
    expect(resolution.status).toBe('configured');
    if (resolution.status !== 'configured') return;

    // The trailing slash is gone, so the path this client builds is
    // `…/internal/v1/inference` and never `…//internal/v1/inference`.
    expect(resolution.config.baseUrl).toBe('https://kaana.internal');
    expect(resolution.config.keyId).toBe(COMPLETE[KAANA_SIGNING_KEY_ID_VARIABLE]);
    expect(resolution.config.privateKey.asymmetricKeyType).toBe('ed25519');
    expect(mockedLogger.error).not.toHaveBeenCalled();
  });

  it('accepts the base64-of-PEM form production supplies through SSM', () => {
    configure({
      ...COMPLETE,
      [KAANA_SIGNING_PRIVATE_KEY_VARIABLE]: Buffer.from(EDGE_PRIVATE_PEM, 'utf8').toString(
        'base64'
      ),
    });

    const resolution = resolveKaanaDataPlane();
    expect(resolution.status).toBe('configured');
    if (resolution.status !== 'configured') return;
    // The SAME key as the PEM form, not merely another usable one: the public
    // half is what the data plane is configured with, so the two encodings
    // agreeing is the property that matters.
    expect(kaanaPublicKeyBase64(resolution.config)).toBe(
      Buffer.from(
        edgeKey.publicKey.export({ format: 'jwk' }).x as string,
        'base64url'
      ).toString('base64')
    );
  });

  it('derives the 32-byte public key the data plane’s own key set takes', () => {
    configure(COMPLETE);

    const resolution = resolveKaanaDataPlane();
    expect(resolution.status).toBe('configured');
    if (resolution.status !== 'configured') return;

    const encoded = kaanaPublicKeyBase64(resolution.config);
    // The data plane refuses a key that decodes to any other length, so this is
    // the assertion that would catch an SPKI header leaking into the value.
    expect(Buffer.from(encoded, 'base64')).toHaveLength(32);
  });
});
