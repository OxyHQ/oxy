/**
 * Environment configuration validation tests
 *
 * Focus: REFRESH_COOKIE_DOMAIN strict validation (MED-2). Refresh cookies
 * default to host-only scope. If the emergency Domain override is used, it must
 * be exactly the API host so bearer-equivalent cookies never leak to sibling
 * subdomain servers.
 */

import {
  isValidHostname,
  validateRequiredEnvVars,
  ConfigurationError,
  DEV_DEVICE_ID_SALT_DEFAULT,
} from '../env';
import { logger } from '../../utils/logger';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const REQUIRED_BASE_ENV: Record<string, string> = {
  DATABASE_URL: 'postgres://oxy:oxy@127.0.0.1:5432/oxy_test',
  ACCESS_TOKEN_SECRET: 'a'.repeat(64),
  REFRESH_TOKEN_SECRET: 'b'.repeat(64),
  AWS_REGION: 'eu-west-1',
  AWS_ACCESS_KEY_ID: 'test-access-key',
  AWS_SECRET_ACCESS_KEY: 'test-secret-key',
  AWS_S3_BUCKET: 'test-bucket',
};

describe('isValidHostname', () => {
  const VALID = [
    'oxy.so',
    'api.oxy.so',
    'localhost',
    'sub-domain.example.com',
    'a.b.c.d.e',
    'xn--bcher-kva.example',
  ];

  const INVALID = [
    'oxy.so; Secure',
    'oxy.so,evil.com',
    'http://oxy.so',
    'oxy .so',
    'oxy.so\nSet-Cookie: x=y',
    'oxy.so\r',
    '.oxy.so',
    'oxy.so.',
    'oxy.so:443',
    'oxy.so/path',
    '-oxy.so',
    'oxy-.so',
    '',
    ' ',
    'oxy_so',
    `${'a'.repeat(64)}.so`,
    `${'a.'.repeat(127)}a${'b'.repeat(10)}`,
  ];

  it.each(VALID)('accepts %j', (value) => {
    expect(isValidHostname(value)).toBe(true);
  });

  it.each(INVALID)('rejects %j', (value) => {
    expect(isValidHostname(value)).toBe(false);
  });
});

describe('validateRequiredEnvVars — DATABASE_URL', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, ...REQUIRED_BASE_ENV };
    process.env.NODE_ENV = 'development';
    process.env.DEVICE_ID_SALT = 'x'.repeat(48);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('fails fast when DATABASE_URL is unset', () => {
    delete process.env.DATABASE_URL;
    expect(() => validateRequiredEnvVars()).toThrow(ConfigurationError);
    expect(() => validateRequiredEnvVars()).toThrow(/DATABASE_URL/);
  });

  it.each(['postgres://oxy@localhost:5432/oxy', 'postgresql://oxy@localhost:5432/oxy'])(
    'accepts %s without a shape warning',
    (url) => {
      process.env.DATABASE_URL = url;
      expect(() => validateRequiredEnvVars()).not.toThrow();
      const warnCalls = JSON.stringify((logger.warn as jest.Mock).mock.calls);
      expect(warnCalls).not.toMatch(/DATABASE_URL/);
    }
  );

  it('warns (but does not throw) when DATABASE_URL is not a Postgres URI', () => {
    process.env.DATABASE_URL = 'mysql://oxy@localhost:3306/oxy';
    expect(() => validateRequiredEnvVars()).not.toThrow();
    const warnCalls = JSON.stringify((logger.warn as jest.Mock).mock.calls);
    expect(warnCalls).toMatch(/DATABASE_URL/);
  });

  it('boots with no MONGODB_URI at all — Mongo left the serving path', () => {
    delete process.env.MONGODB_URI;
    expect(() => validateRequiredEnvVars()).not.toThrow();
  });
});

describe('validateRequiredEnvVars — DEVICE_ID_SALT (security review H1)', () => {
  const originalEnv = process.env;
  const STRONG_SALT = 'x'.repeat(48);

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, ...REQUIRED_BASE_ENV };
    delete process.env.REFRESH_COOKIE_DOMAIN;
    delete process.env.DEVICE_ID_SALT;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('in production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('fails fast when DEVICE_ID_SALT is unset', () => {
      expect(() => validateRequiredEnvVars()).toThrow(ConfigurationError);
      expect(() => validateRequiredEnvVars()).toThrow(/DEVICE_ID_SALT/);
    });

    it('fails fast when DEVICE_ID_SALT is too short', () => {
      process.env.DEVICE_ID_SALT = 'too-short';
      expect(() => validateRequiredEnvVars()).toThrow(ConfigurationError);
      expect(() => validateRequiredEnvVars()).toThrow(/DEVICE_ID_SALT/);
      expect(() => validateRequiredEnvVars()).toThrow(/at least 32/);
    });

    it('passes for a strong salt and does NOT log a placeholder warning', () => {
      process.env.DEVICE_ID_SALT = STRONG_SALT;
      expect(() => validateRequiredEnvVars()).not.toThrow();
      const warnCalls = (logger.warn as jest.Mock).mock.calls.flat().join(' ');
      expect(warnCalls).not.toMatch(/development-only placeholder/);
    });

    it('NEVER installs the dev placeholder in production', () => {
      expect(() => validateRequiredEnvVars()).toThrow();
      expect(process.env.DEVICE_ID_SALT).toBeUndefined();
    });
  });

  describe('in development', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
    });

    it('installs the documented dev placeholder when DEVICE_ID_SALT is unset', () => {
      expect(() => validateRequiredEnvVars()).not.toThrow();
      expect(process.env.DEVICE_ID_SALT).toBe(DEV_DEVICE_ID_SALT_DEFAULT);
    });

    it('logs an explicit WARN when falling back to the dev placeholder', () => {
      validateRequiredEnvVars();
      const warnCalls = (logger.warn as jest.Mock).mock.calls;
      const matched = warnCalls.some(([msg]) =>
        typeof msg === 'string' && /development-only placeholder/.test(msg)
      );
      expect(matched).toBe(true);
    });

    it('does NOT overwrite an operator-provided dev salt', () => {
      process.env.DEVICE_ID_SALT = STRONG_SALT;
      validateRequiredEnvVars();
      expect(process.env.DEVICE_ID_SALT).toBe(STRONG_SALT);
    });

    it('still rejects a too-short salt in development', () => {
      process.env.DEVICE_ID_SALT = 'too-short';
      expect(() => validateRequiredEnvVars()).toThrow(ConfigurationError);
      expect(() => validateRequiredEnvVars()).toThrow(/DEVICE_ID_SALT/);
    });
  });
});
