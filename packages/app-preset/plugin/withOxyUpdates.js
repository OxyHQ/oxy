/**
 * Expo Config Plugin: withOxyUpdates
 *
 * Points `expo-updates` at the self-hosted **Oxy Updates** server (`/updates/v1`
 * in oxy-api) and wires the ecosystem code-signing certificate, so an app opts
 * into OTA with one plugin entry plus its own client id instead of a hand-written
 * `updates` block, a per-repo certificate copy, and a per-repo runtime-version
 * policy that drift apart.
 *
 * In app.config.js:
 *
 *   plugins: [
 *     'expo-updates',
 *     ['@oxyhq/app-preset/plugin/withOxyUpdates', { clientId: OXY_CLIENT_ID }],
 *   ]
 *
 * What it sets:
 *   - `updates.url` = `<apiOrigin>/updates/v1/apps/<clientId>/manifest`
 *   - `updates.requestHeaders['expo-channel-name']` = the release channel
 *   - `updates.codeSigningCertificate` + `updates.codeSigningMetadata` (see below)
 *   - `runtimeVersion` = `{ policy: 'appVersion' }`
 *
 * **runtimeVersion policy: `appVersion`, deliberately.** It is the only policy the
 * whole Oxy toolchain can resolve end to end. `oxy-ship` derives the publish
 * runtime from `expo config --json --type public`, and `fingerprint` resolves
 * there to the sentinel `file:fingerprint` (it is computed at BUILD time, not at
 * config time), so a fingerprint app would have to pass `--runtime-version` by
 * hand on every publish. The consequence is a rule to keep: **the app `version`
 * is the OTA compatibility boundary.** Bump it whenever native code changes.
 * Installs on the old `version` then correctly stop receiving updates published
 * under the new one, whereas installs on an UNBUMPED version would receive JS
 * that assumes native modules they do not have.
 *
 * **Code signing.** The Oxy Updates server signs manifests with
 * `rsa-v1_5-sha256` under keyid `main` (`CODE_SIGNING_ALG` / `CODE_SIGNING_KEY_ID`
 * in oxy-api's `services/updates/signing.service.ts`); those two values are
 * mirrored here and must be changed together. The matching PUBLIC certificate is
 * a single ecosystem-wide file shipped inside this package
 * (`certs/oxy-updates-code-signing.pem`) rather than copied into every app repo,
 * so a key rotation is one preset bump instead of thirteen.
 *
 * Until that certificate is committed the plugin wires the update URL but NOT
 * signature verification, and warns on both platforms. A binary built in that
 * state can never verify a manifest signature for its whole lifetime, because the
 * certificate is baked into the native build, so **do not ship a store build of
 * an OTA-enabled app before the certificate exists.** Pass
 * `{ codeSigning: 'require' }` to turn that warning into a hard build failure.
 *
 * @param {import('expo/config').ExpoConfig} config
 * @param {object} options
 * @param {string} options.clientId Registered `ApplicationCredential` publicKey
 *   (`oxy_dk_...`) identifying this app to the update server. Required.
 * @param {string} [options.apiOrigin='https://api.oxy.so'] Origin serving `/updates/v1`.
 * @param {string} [options.channel='production'] Release channel this binary tracks.
 * @param {'auto'|'require'|false} [options.codeSigning='auto'] `auto` wires
 *   signing when the certificate is present and warns when it is not; `require`
 *   throws when it is absent; `false` skips signing entirely.
 * @param {string} [options.certificatePath] Absolute path to a different
 *   certificate than the bundled one. Normally unset; it exists for the overlap
 *   window of a key rotation, where one binary has to trust an incoming
 *   certificate the rest of the ecosystem has not moved to yet.
 * @param {'appVersion'|'nativeVersion'|'sdkVersion'|'fingerprint'|false} [options.runtimeVersionPolicy='appVersion']
 *   `false` leaves whatever the app declared.
 */
const fs = require('fs');
const path = require('path');
const { WarningAggregator } = require('expo/config-plugins');

/** Origin of the Oxy Updates server. `updates.oxy.so` does not exist; oxy-api serves it. */
const DEFAULT_API_ORIGIN = 'https://api.oxy.so';

/** Channel a binary tracks unless it opts into a preview track. */
const DEFAULT_CHANNEL = 'production';

/** Mirrors `CODE_SIGNING_KEY_ID` in oxy-api `services/updates/signing.service.ts`. */
const CODE_SIGNING_KEY_ID = 'main';

/** Mirrors `CODE_SIGNING_ALG` in oxy-api `services/updates/signing.service.ts`. */
const CODE_SIGNING_ALG = 'rsa-v1_5-sha256';

/**
 * The one ecosystem-wide PUBLIC code-signing certificate, generated together with
 * the server's private key by oxy-api's `scripts/generate-updates-code-signing.ts`.
 */
const CERTIFICATE_PATH = path.join(__dirname, '..', 'certs', 'oxy-updates-code-signing.pem');

/** Plugin name used in build warnings and errors. */
const PLUGIN_NAME = '@oxyhq/app-preset/plugin/withOxyUpdates';

module.exports = function withOxyUpdates(config, options = {}) {
  const {
    clientId,
    apiOrigin = DEFAULT_API_ORIGIN,
    channel = DEFAULT_CHANNEL,
    codeSigning = 'require',
    certificatePath = CERTIFICATE_PATH,
    runtimeVersionPolicy = 'appVersion',
  } = options;

  if (typeof clientId !== 'string' || clientId.trim().length === 0) {
    throw new Error(
      `[${PLUGIN_NAME}] a non-empty \`clientId\` is required. Pass this app's registered `
        + 'ApplicationCredential publicKey (oxy_dk_...), normally from an '
        + 'EXPO_PUBLIC_OXY_CLIENT_ID-backed constant.',
    );
  }

  // Trimmed with a loop rather than a `/\/+$/` regex: an anchored repetition is
  // the polynomial-ReDoS shape CodeQL flags (js/polynomial-redos), and this is
  // linear and just as clear.
  let origin = apiOrigin;
  while (origin.endsWith('/')) {
    origin = origin.slice(0, -1);
  }

  const updates = { ...config.updates };
  updates.url = `${origin}/updates/v1/apps/${clientId}/manifest`;
  updates.requestHeaders = { ...updates.requestHeaders, 'expo-channel-name': channel };

  if (codeSigning !== false) {
    if (fs.existsSync(certificatePath)) {
      const projectRoot = config._internal?.projectRoot;
      if (typeof projectRoot !== 'string') {
        throw new Error(
          `[${PLUGIN_NAME}] could not resolve the project root from the Expo config, so the `
            + 'code-signing certificate path cannot be made project-relative (expo-updates joins it '
            + 'onto the project root). Upgrade @expo/config, or pass `{ codeSigning: false }`.',
        );
      }
      // expo-updates reads this as `path.join(projectRoot, value)`, so it must be
      // relative: an absolute path would be appended to the project root.
      updates.codeSigningCertificate = path.relative(projectRoot, certificatePath);
      updates.codeSigningMetadata = { keyid: CODE_SIGNING_KEY_ID, alg: CODE_SIGNING_ALG };
    } else if (codeSigning === 'require') {
      throw new Error(
        `[${PLUGIN_NAME}] code signing is required but the Oxy Updates certificate is missing at `
          + `${certificatePath}. Generate the ecosystem keypair with oxy-api's `
          + '`bun scripts/generate-updates-code-signing.ts`, commit the certificate into '
          + '@oxyhq/app-preset, and set the private key as UPDATES_CODE_SIGNING_PRIVATE_KEY on oxy-api.',
      );
    } else {
      const warning =
        'The Oxy Updates code-signing certificate is not present in @oxyhq/app-preset, so this build '
        + 'will accept UNSIGNED update manifests for its entire lifetime (the certificate is baked in '
        + 'at build time). Do not ship this binary to a store. See the app-preset README, section '
        + '"Oxy Updates (OTA)".';
      WarningAggregator.addWarningForPlatform('android', PLUGIN_NAME, warning);
      WarningAggregator.addWarningForPlatform('ios', PLUGIN_NAME, warning);
    }
  }

  const next = { ...config, updates };

  if (runtimeVersionPolicy !== false) {
    next.runtimeVersion = { policy: runtimeVersionPolicy };
  }

  return next;
};
