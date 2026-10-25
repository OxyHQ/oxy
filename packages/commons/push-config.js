/**
 * Build-time push configuration for Commons: the EAS project id and Firebase's
 * `google-services.json`. Plain CommonJS, read by `app.config.js`.
 *
 * Commons is woken by push for "Sign in with Oxy" approvals. Two things must be
 * IN THE BINARY for that, and neither belongs in the repository:
 *
 * 1. `extra.eas.projectId` — `getExpoPushTokenAsync` mints a token only for an
 *    EAS project; without it every install of the build has no push token and
 *    the server can never reach it (`@oxy.so/services` logs "no EAS project id").
 *    Provide `OXY_COMMONS_EAS_PROJECT_ID` (a UUID, from `eas init` / expo.dev),
 *    or `EAS_PROJECT_ID`.
 * 2. `android.googleServicesFile` — Expo push reaches Android through FCM, which
 *    needs the Firebase app's `google-services.json` for this package name.
 *    Provide `OXY_COMMONS_GOOGLE_SERVICES_FILE` (a path), or drop the file at
 *    `packages/commons/google-services.json` (gitignored).
 *
 * Missing values are a WARNING, not an error: a development build without push
 * is legitimate. A value that is present but wrong (a project id that is not a
 * UUID, a path to nothing, a Firebase file for another package) is an ERROR,
 * because it would produce a binary that looks configured and cannot receive a
 * push. A release pipeline sets `OXY_COMMONS_REQUIRE_PUSH=true`, which turns a
 * missing value into an error too.
 */
const fs = require('node:fs');
const path = require('node:path');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {{ env?: NodeJS.ProcessEnv, projectRoot?: string, packageName: string, warn?: (message: string) => void }} options
 * @returns {{ easProjectId: string | undefined, googleServicesFile: string | undefined }}
 */
function resolvePushConfig({
  env = process.env,
  projectRoot = __dirname,
  packageName,
  warn = (message) => console.warn(message),
}) {
  const required = env.OXY_COMMONS_REQUIRE_PUSH === 'true';
  const missing = [];

  const projectId = (env.OXY_COMMONS_EAS_PROJECT_ID ?? env.EAS_PROJECT_ID ?? '').trim();
  if (projectId && !UUID.test(projectId)) {
    throw new Error(
      `[commons push] OXY_COMMONS_EAS_PROJECT_ID is not an EAS project id (a UUID): "${projectId}".`,
    );
  }
  if (!projectId) {
    missing.push(
      'OXY_COMMONS_EAS_PROJECT_ID (the EAS project id; without it no install of this build gets an Expo push token)',
    );
  }

  const explicitFile = (env.OXY_COMMONS_GOOGLE_SERVICES_FILE ?? '').trim();
  const defaultFile = path.join(projectRoot, 'google-services.json');
  let googleServicesFile;
  if (explicitFile) {
    const absolute = path.resolve(projectRoot, explicitFile);
    if (!fs.existsSync(absolute)) {
      throw new Error(
        `[commons push] OXY_COMMONS_GOOGLE_SERVICES_FILE points at ${absolute}, which does not exist.`,
      );
    }
    googleServicesFile = absolute;
  } else if (fs.existsSync(defaultFile)) {
    googleServicesFile = defaultFile;
  } else {
    missing.push(
      `OXY_COMMONS_GOOGLE_SERVICES_FILE or ${path.relative(process.cwd(), defaultFile) || defaultFile} (Firebase config; without it Android receives no push)`,
    );
  }

  if (googleServicesFile) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(googleServicesFile, 'utf8'));
    } catch {
      throw new Error(`[commons push] ${googleServicesFile} is not valid JSON.`);
    }
    const packages = (parsed.client ?? [])
      .map((client) => client?.client_info?.android_client_info?.package_name)
      .filter((name) => typeof name === 'string');
    if (!packages.includes(packageName)) {
      throw new Error(
        `[commons push] ${googleServicesFile} has no Android app for ${packageName} ` +
          `(it has: ${packages.join(', ') || 'none'}). Register ${packageName} in the Firebase project ` +
          'and download its google-services.json.',
      );
    }
  }

  if (missing.length > 0) {
    const message = `[commons push] push is NOT configured for this build. Missing: ${missing.join('; ')}.`;
    if (required) {
      throw new Error(`${message} (OXY_COMMONS_REQUIRE_PUSH=true)`);
    }
    warn(message);
  }

  return {
    easProjectId: projectId || undefined,
    // expo-config joins this onto the project root.
    googleServicesFile: googleServicesFile
      ? path.relative(projectRoot, googleServicesFile)
      : undefined,
  };
}

module.exports = { resolvePushConfig };
