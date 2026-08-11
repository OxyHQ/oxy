/**
 * The two halves of the retired flat account list that a text scan cannot prove
 * gone.
 *
 * `scripts/validate-no-flat-account-list.mjs` bans the identifiers that left the
 * packages outright — `SwitchableAccount`, `projectSwitchableAccounts`,
 * `useSwitchableAccounts`, `useAccountStore` and the rest — because each of
 * those names is unique enough that a match is always a reintroduction. Two
 * pieces of the same removal are NOT: an `accounts` field on the snapshot and a
 * `switchTo` method on the controller are ordinary words. `'accounts'` is a live
 * VIEW name three lines away in the same file, so a scoped grep there would fire
 * on the thing that is supposed to be there.
 *
 * ## Why this is a RUNTIME check and not a type-level one
 *
 * A `type Has<S, K> = K extends keyof S ? true : false` assertion reads better
 * and is checked by nothing here. `packages/core/tsconfig*.json` all carry
 * `"exclude": ["**\/__tests__"]`, so `tsc` never sees a test file, and
 * `jest.config.js` sets `diagnostics: false`, so ts-jest transpiles without
 * typechecking. That version was written first and MUTATION-TESTED: putting
 * `accounts: string[]` back on the interface and `switchTo()` back on the class
 * left both assertions green. It is recorded here because the type-level form is
 * the obvious thing to reach for, and it cannot fail in this package.
 *
 * The residual gap of the runtime form is an OPTIONAL field nobody writes —
 * `accounts?: SwitchableAccount[]` would satisfy `tsc` without appearing on a
 * snapshot. A REQUIRED one cannot hide: `computeSnapshot()` is strict, so the
 * field has to be populated, and then it is here. An optional list nothing
 * writes is not the mechanism coming back.
 */

import type { DeviceSessionState } from '@oxyhq/contracts';
import type { OxyServices } from '../../OxyServices';
import { SessionClient, type SessionClientHost } from '../SessionClient';
import { createAccountDialogController } from '../accountDialogController';

const host: SessionClientHost = {
  makeRequest: jest.fn(async () => undefined),
  getBaseURL: () => 'http://test.invalid',
  getAccessToken: () => null,
  getDeviceCredential: () => null,
  onTokensChanged: () => () => undefined,
  setTokens: jest.fn(),
  getCurrentAccountId: () => null,
};

const oxyServices = {
  getAccessToken: jest.fn(() => null),
  getBaseURL: jest.fn(() => 'http://test.invalid'),
  onTokensChanged: jest.fn(() => () => undefined),
  getFileDownloadUrl: jest.fn((id: string) => `https://cdn/${id}`),
} as unknown as OxyServices;

/**
 * Every key the snapshot carries, and the whole set of them.
 *
 * An exact set rather than `not.toContain('accounts')` on purpose: it fails on
 * ANY new field, not only on one spelled the way the old one was. The snapshot
 * is a published contract that four surfaces render from, so growing it should
 * be a deliberate edit here — and a flat list would come back under a new name
 * (`rows`, `switchable`, `entries`) at least as readily as under the old one,
 * which a name-specific check would wave through.
 */
const SNAPSHOT_KEYS = [
  'activatingContextId',
  'activeContext',
  'commonsAvailability',
  'directory',
  'error',
  'loading',
  'removingContextId',
  'removingPrincipalId',
  'signIn',
  'view',
];

describe('the account dialog surface after the flat list was retired', () => {
  it('carries the server directory, and no flat account list beside it', () => {
    const controller = createAccountDialogController({
      oxyServices,
      sessionClient: new SessionClient(host),
      clientId: 'oxy_dk_test',
    });

    const snapshot = controller.getSnapshot();

    // The absence half. `accounts` was the deduped union of the device's
    // sign-ins and the CALLER's account graph — and a client holds one caller's
    // graph and cannot enumerate another principal's, so on a device holding two
    // people it answered with one person's accounts as though they were the
    // device's.
    expect(Object.keys(snapshot).sort()).toEqual(SNAPSHOT_KEYS);

    // The positive control, in the same assertion and again here: a snapshot
    // that stopped being built at all would satisfy "has no `accounts`" too.
    expect(snapshot).toHaveProperty('directory');
    expect(snapshot).toHaveProperty('activeContext');
  });

  it('switches on a context pair, and offers no account-id switch', () => {
    const controller = createAccountDialogController({
      oxyServices,
      sessionClient: new SessionClient(host),
      clientId: 'oxy_dk_test',
    });

    // `switchTo(accountId)` could not express WHICH person's route into a shared
    // organization was being taken, so on a device where two people both reach
    // one org it chose for the user. `activateContext(contextId)` names the
    // pair, and `signOutContext` / `signOutPrincipal` are the two removals an
    // account id likewise cannot name.
    expect('switchTo' in controller).toBe(false);

    expect(typeof controller.activateContext).toBe('function');
    expect(typeof controller.signOutContext).toBe('function');
    expect(typeof controller.signOutPrincipal).toBe('function');
  });
});
