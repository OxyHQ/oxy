import {
  PUSH_SOURCE,
  resolveApprovedAction,
  SCANNER_SOURCE,
} from '@/lib/commons-signin/approval-return';

describe('resolveApprovedAction', () => {
  it('returns to the caller for an external deep link on Android', () => {
    // No `source` param → the same-device deep-link handoff; Android can
    // background Commons to return to the app/site that launched it.
    expect(resolveApprovedAction(undefined, 'android')).toBe('return-to-caller');
  });

  it('stays in Commons for the in-app scanner path on Android', () => {
    // Cross-device QR: there is no caller on THIS device to return to.
    expect(resolveApprovedAction(SCANNER_SOURCE, 'android')).toBe('close');
    expect(resolveApprovedAction('scanner', 'android')).toBe('close');
  });

  it('stays in Commons on iOS regardless of source (no programmatic backgrounding)', () => {
    expect(resolveApprovedAction(undefined, 'ios')).toBe('close');
    expect(resolveApprovedAction(SCANNER_SOURCE, 'ios')).toBe('close');
  });

  it('stays in Commons for any non-Android platform on the deep-link path', () => {
    expect(resolveApprovedAction(undefined, 'web')).toBe('close');
  });

  it('treats an unrelated source value as a deep link', () => {
    // Only the exact `scanner` sentinel marks the in-app path; anything else
    // (including a spoofed value) is treated as external → Android returns.
    expect(resolveApprovedAction('elsewhere', 'android')).toBe('return-to-caller');
    expect(resolveApprovedAction('elsewhere', 'ios')).toBe('close');
  });

  // A push is cross-device by construction: approving from one on Android used
  // to run BackHandler.exitApp() and close Commons.
  it('stays in Commons after approving from a push', () => {
    expect(PUSH_SOURCE).toBe('push');
    expect(resolveApprovedAction(PUSH_SOURCE, 'android')).toBe('close');
    expect(resolveApprovedAction(PUSH_SOURCE, 'ios')).toBe('close');
  });
});
