/**
 * Unit tests for the withOxyUpdates config plugin.
 *
 * Run with the package's own `bun run test` (Node's built-in test runner, so a
 * zero-build config package stays dependency-free).
 *
 * Most certificate cases use a temporary file rather than the bundled one; the
 * bundled ecosystem certificate itself is checked at the end of the file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const withOxyUpdates = require('../plugin/withOxyUpdates');

const CLIENT_ID = 'oxy_dk_0123456789abcdef0123456789abcdef0123456789abcdef';
const PROJECT_ROOT = path.join(os.tmpdir(), 'oxy-app-preset-test-project');

/** Minimal ExpoConfig shape carrying the internals a static plugin receives. */
function baseConfig(extra = {}) {
  return { name: 'Test', slug: 'test', _internal: { projectRoot: PROJECT_ROOT }, ...extra };
}

/** Options for tests whose behavior is unrelated to code signing. */
function unsignedOptions(extra = {}) {
  return { clientId: CLIENT_ID, codeSigning: false, ...extra };
}

/** Write a throwaway certificate file and hand its path to `fn`, always cleaning up. */
function withTemporaryCertificate(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oxy-updates-cert-'));
  const file = path.join(dir, 'oxy-updates-code-signing.pem');
  fs.writeFileSync(file, '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n');
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('rejects a missing or blank clientId', () => {
  assert.throws(() => withOxyUpdates(baseConfig(), {}), /non-empty `clientId` is required/);
  assert.throws(() => withOxyUpdates(baseConfig(), { clientId: '  ' }), /non-empty `clientId`/);
});

test('builds the manifest URL from the client id and the default origin', () => {
  const config = withOxyUpdates(baseConfig(), unsignedOptions());
  assert.equal(config.updates.url, `https://api.oxy.so/updates/v1/apps/${CLIENT_ID}/manifest`);
});

test('honours an explicit apiOrigin and strips its trailing slashes', () => {
  const config = withOxyUpdates(
    baseConfig(),
    unsignedOptions({
      apiOrigin: 'http://localhost:3001//',
    }),
  );
  assert.equal(config.updates.url, `http://localhost:3001/updates/v1/apps/${CLIENT_ID}/manifest`);
});

test('sets the channel request header without dropping existing headers', () => {
  const config = withOxyUpdates(
    baseConfig({ updates: { requestHeaders: { 'x-existing': 'kept' } } }),
    unsignedOptions({ channel: 'pr-42' }),
  );
  assert.deepEqual(config.updates.requestHeaders, {
    'x-existing': 'kept',
    'expo-channel-name': 'pr-42',
  });
});

test('defaults the runtime version to the appVersion policy', () => {
  const config = withOxyUpdates(baseConfig(), unsignedOptions());
  assert.deepEqual(config.runtimeVersion, { policy: 'appVersion' });
});

test('honours another runtime version policy, and leaves the app value alone when false', () => {
  const fingerprint = withOxyUpdates(
    baseConfig(),
    unsignedOptions({
      runtimeVersionPolicy: 'fingerprint',
    }),
  );
  assert.deepEqual(fingerprint.runtimeVersion, { policy: 'fingerprint' });

  const untouched = withOxyUpdates(
    baseConfig({ runtimeVersion: '9.9.9' }),
    unsignedOptions({
      runtimeVersionPolicy: false,
    }),
  );
  assert.equal(untouched.runtimeVersion, '9.9.9');
});

test('wires the certificate as a project-relative path, with metadata matching the server', () => {
  withTemporaryCertificate((certificatePath) => {
    const config = withOxyUpdates(baseConfig(), { clientId: CLIENT_ID, certificatePath });

    // expo-updates resolves this as `path.join(projectRoot, value)`, so the value
    // must be relative and must land back on the real file.
    assert.equal(
      config.updates.codeSigningCertificate,
      path.relative(PROJECT_ROOT, certificatePath),
    );
    assert.ok(!path.isAbsolute(config.updates.codeSigningCertificate));
    assert.equal(path.join(PROJECT_ROOT, config.updates.codeSigningCertificate), certificatePath);

    // Must equal CODE_SIGNING_KEY_ID / CODE_SIGNING_ALG in oxy-api's
    // services/updates/signing.service.ts, or every signature check fails.
    assert.deepEqual(config.updates.codeSigningMetadata, {
      keyid: 'main',
      alg: 'rsa-v1_5-sha256',
    });
  });
});

test('skips signing entirely when codeSigning is false, even with a certificate present', () => {
  withTemporaryCertificate((certificatePath) => {
    const config = withOxyUpdates(baseConfig(), {
      clientId: CLIENT_ID,
      certificatePath,
      codeSigning: false,
    });
    assert.equal(config.updates.codeSigningCertificate, undefined);
    assert.equal(config.updates.codeSigningMetadata, undefined);
    // The update URL is still wired: only verification is opted out of.
    assert.ok(config.updates.url.includes(CLIENT_ID));
  });
});

test('throws when required code signing has no certificate', () => {
  assert.throws(
    () =>
      withOxyUpdates(baseConfig(), {
        clientId: CLIENT_ID,
        certificatePath: path.join(os.tmpdir(), 'oxy-updates-absent.pem'),
        codeSigning: 'require',
      }),
    /certificate is missing .* would accept unsigned updates/s,
  );
});

test('fails closed by default: no certificate, no build', () => {
  assert.throws(
    () =>
      withOxyUpdates(baseConfig(), {
        clientId: CLIENT_ID,
        certificatePath: path.join(os.tmpdir(), 'oxy-updates-absent.pem'),
      }),
    /certificate is missing/,
  );
});

test('refuses a certificate file that is not a PEM certificate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oxy-updates-cert-'));
  const file = path.join(dir, 'oxy-updates-code-signing.pem');
  // A private key committed by mistake is exactly what this must catch.
  fs.writeFileSync(file, '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n');
  try {
    assert.throws(
      () => withOxyUpdates(baseConfig(), { clientId: CLIENT_ID, certificatePath: file }),
      /is not a PEM certificate/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects an unknown codeSigning value rather than treating it as on or off', () => {
  assert.throws(
    () => withOxyUpdates(baseConfig(), { clientId: CLIENT_ID, codeSigning: 'yes' }),
    /must be 'require' \(the default\), 'auto' or false/,
  );
});

test('the bundled ecosystem certificate is a valid code-signing certificate, and is wired by default', () => {
  const bundled = path.join(__dirname, '..', 'certs', 'oxy-updates-code-signing.pem');
  const pem = fs.readFileSync(bundled, 'utf8');
  assert.doesNotMatch(pem, /PRIVATE KEY/);
  const certificate = new (require('node:crypto').X509Certificate)(pem);
  assert.equal(certificate.subject, 'CN=Oxy Updates Code Signing');
  assert.ok(certificate.publicKey.asymmetricKeyType === 'rsa');
  // Code signing EKU (1.3.6.1.5.5.7.3.3): expo-updates refuses a cert without it.
  assert.ok(certificate.keyUsage?.includes('1.3.6.1.5.5.7.3.3'));
  assert.ok(new Date(certificate.validTo).getTime() > Date.now() + 5 * 365 * 24 * 3600 * 1000);

  const config = withOxyUpdates(baseConfig(), { clientId: CLIENT_ID });
  assert.equal(path.join(PROJECT_ROOT, config.updates.codeSigningCertificate), bundled);
});

test('wires the URL but no signing when the certificate is absent and codeSigning is auto', () => {
  const config = withOxyUpdates(baseConfig(), {
    clientId: CLIENT_ID,
    certificatePath: path.join(os.tmpdir(), 'oxy-updates-absent.pem'),
    codeSigning: 'auto',
  });
  assert.ok(config.updates.url.includes(CLIENT_ID));
  assert.equal(config.updates.codeSigningCertificate, undefined);
});

test('fails loudly when the project root is unavailable and a certificate must be wired', () => {
  withTemporaryCertificate((certificatePath) => {
    assert.throws(
      () =>
        withOxyUpdates({ name: 'Test', slug: 'test' }, { clientId: CLIENT_ID, certificatePath }),
      /could not resolve the project root/,
    );
  });
});
