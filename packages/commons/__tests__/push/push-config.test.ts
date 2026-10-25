/**
 * Push needs two values IN THE BINARY that never belong in the repo: the EAS
 * project id and Firebase's google-services.json. `push-config.js` reads them
 * from the build environment and refuses a value that is present but wrong.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// biome-ignore lint/style/noCommonJs: app.config.js and its helper are CommonJS by design.
const { resolvePushConfig } = require('../../push-config.js') as {
  resolvePushConfig: (options: {
    env?: Record<string, string>;
    projectRoot?: string;
    packageName: string;
    warn?: (message: string) => void;
  }) => { easProjectId?: string; googleServicesFile?: string };
};

const PROJECT_ID = '3f0f5f3e-6a7b-4c2d-9e8f-0123456789ab';
const PACKAGE = 'so.oxy.commons';

function root(withFile?: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'commons-push-'));
  if (withFile) writeFileSync(join(dir, 'google-services.json'), JSON.stringify(withFile));
  return dir;
}

const firebase = (packageName: string) => ({
  project_info: { project_id: 'oxy' },
  client: [{ client_info: { android_client_info: { package_name: packageName } } }],
});

describe('resolvePushConfig', () => {
  it('reads the project id from the environment and the Firebase file from the project', () => {
    const projectRoot = root(firebase(PACKAGE));
    const warn = jest.fn();
    expect(
      resolvePushConfig({
        env: { OXY_COMMONS_EAS_PROJECT_ID: PROJECT_ID },
        projectRoot,
        packageName: PACKAGE,
        warn,
      }),
    ).toEqual({ easProjectId: PROJECT_ID, googleServicesFile: 'google-services.json' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns, and configures nothing, when neither is provided (a development build)', () => {
    const warn = jest.fn();
    expect(resolvePushConfig({ env: {}, projectRoot: root(), packageName: PACKAGE, warn })).toEqual({
      easProjectId: undefined,
      googleServicesFile: undefined,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/push is NOT configured/));
  });

  it('fails a release build (OXY_COMMONS_REQUIRE_PUSH=true) that misses either', () => {
    expect(() =>
      resolvePushConfig({
        env: { OXY_COMMONS_REQUIRE_PUSH: 'true', OXY_COMMONS_EAS_PROJECT_ID: PROJECT_ID },
        projectRoot: root(),
        packageName: PACKAGE,
      }),
    ).toThrow(/google-services/);
  });

  it('refuses a value that is present but wrong', () => {
    expect(() =>
      resolvePushConfig({
        env: { OXY_COMMONS_EAS_PROJECT_ID: 'my-project' },
        projectRoot: root(),
        packageName: PACKAGE,
        warn: () => undefined,
      }),
    ).toThrow(/not an EAS project id/);
    expect(() =>
      resolvePushConfig({
        env: { OXY_COMMONS_GOOGLE_SERVICES_FILE: './nowhere.json' },
        projectRoot: root(),
        packageName: PACKAGE,
        warn: () => undefined,
      }),
    ).toThrow(/does not exist/);
    expect(() =>
      resolvePushConfig({
        env: {},
        projectRoot: root(firebase('so.oxy.mention')),
        packageName: PACKAGE,
        warn: () => undefined,
      }),
    ).toThrow(/no Android app for so\.oxy\.commons/);
  });

  it('app.config.js never ships a placeholder project id', () => {
    const appConfig = require('../../app.config.js') as {
      expo: { extra: { eas: { projectId?: string } }; version: string; android: { versionCode: number } };
    };
    const id = appConfig.expo.extra.eas.projectId;
    expect(id === undefined || /^[0-9a-f-]{36}$/i.test(id)).toBe(true);
  });
});
