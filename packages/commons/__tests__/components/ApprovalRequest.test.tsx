import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import type { CommonsApprovalInfo, PublicApplication } from '@oxyhq/core';
import { __resetOxyState } from '@/__mocks__/oxyhq-services';
import { LocaleProvider } from '@/lib/i18n/locale-context';
import { parseApprovalLink } from '@/lib/commons-signin/parse-approval-link';
import {
  ApprovalRequest,
  type ApprovalRequestProps,
} from '@/components/commons-signin/approval-request';

/** The application identity as the SERVER resolves it from the authorize code. */
const APPLICATION: PublicApplication = {
  id: 'app-1',
  name: 'Mention',
  icon: 'https://cloud.oxy.so/mention-logo.png',
  type: 'first_party',
  isOfficial: true,
  isInternal: false,
  scopes: ['profile:read'],
  developerName: 'Oxy',
  privacyPolicyUrl: 'https://mention.earth/privacy',
};

function makeInfo(overrides: Partial<CommonsApprovalInfo> = {}): CommonsApprovalInfo {
  return {
    application: APPLICATION,
    scopes: ['profile:read', 'email:read'],
    boundOrigin: 'https://mention.earth',
    originVerified: true,
    // The coarse, server-derived client label — the third line of the heading.
    requesterLabel: 'Chrome on Windows',
    purpose: 'device_sign_in',
    subjectAccount: null,
    expiresAt: Date.now() + 300_000,
    status: 'pending',
    ...overrides,
  };
}

function renderRequest(overrides: Partial<ApprovalRequestProps> = {}) {
  const props: ApprovalRequestProps = {
    info: makeInfo(),
    application: APPLICATION,
    identityName: 'Nate',
    confirmationIssue: null,
    onClose: jest.fn(),
    onOpenLink: jest.fn(),
    ...overrides,
  };
  return { props, ...render(<LocaleProvider><ApprovalRequest {...props} /></LocaleProvider>) };
}

describe('ApprovalRequest', () => {
  beforeEach(() => {
    __resetOxyState();
  });

  it('renders the request the SERVER resolved: app, origin, client and scopes', () => {
    const { container } = renderRequest();

    expect(container.textContent).toContain('Sign in to Mention');
    expect(container.textContent).toContain('mention.earth');
    expect(container.textContent).toContain('Chrome on Windows');
    // Scope sentences come from the shared consent dictionary.
    expect(container.textContent).toContain('Read your basic profile');
    expect(container.textContent).toContain('Read your email address');
    // The logo is the server-resolved record's, not a payload-supplied URL.
    expect(container.querySelector('img')?.getAttribute('src')).toBe(APPLICATION.icon);
  });

  it('states who is asking, from where, and on what — in that order', () => {
    const { container, getByTestId } = renderRequest();

    expect(getByTestId('approval-requester').textContent).toBe('Chrome on Windows');

    const text = container.textContent ?? '';
    expect(text.indexOf('Sign in to Mention')).toBeLessThan(text.indexOf('mention.earth'));
    expect(text.indexOf('mention.earth')).toBeLessThan(text.indexOf('Chrome on Windows'));
  });

  it('gives the bare client label a sentence a screen reader can use', () => {
    const { getByLabelText } = renderRequest();

    expect(getByLabelText('Requested from Chrome on Windows').textContent).toBe(
      'Chrome on Windows',
    );
  });

  it('renders the client label verbatim, however the server phrased it', () => {
    const { getByTestId } = renderRequest({
      info: makeInfo({ requesterLabel: 'Firefox' }),
    });

    expect(getByTestId('approval-requester').textContent).toBe('Firefox');
  });

  it('omits the client line entirely when the server has no client to describe', () => {
    // `null` is what a native requester or an unrecognisable User-Agent yields.
    const { container, queryByTestId } = renderRequest({
      info: makeInfo({ requesterLabel: null }),
    });

    expect(queryByTestId('approval-requester')).toBeNull();
    // Nothing is invented in its place — the other two lines stand alone.
    expect(container.textContent).toContain('Sign in to Mention');
    expect(container.textContent).toContain('mention.earth');
    expect(container.textContent).not.toContain('Requested from');
  });

  it('still names the client on a request whose origin could not be verified', () => {
    // This is exactly the request where "was this me?" matters most.
    const { getByTestId } = renderRequest({ info: makeInfo({ originVerified: false }) });

    expect(getByTestId('approval-requester').textContent).toBe('Chrome on Windows');
  });

  it('treats dismissal as a cancel, never a denial', () => {
    const { props, getByLabelText } = renderRequest();

    fireEvent.click(getByLabelText('Close'));

    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows NO delegation chrome for an ordinary personal sign-in', () => {
    const { container, queryByTestId } = renderRequest();

    expect(queryByTestId('approval-delegation')).toBeNull();
    expect(container.textContent).not.toContain('Approving with');
    expect(container.textContent).not.toContain('will act as');
  });

  it('names both the approving identity and the delegated account when delegating', () => {
    const { container, getByTestId } = renderRequest({
      info: makeInfo({
        purpose: 'oauth_authorization',
        subjectAccount: {
          id: 'acct-9',
          username: 'oxycollective',
          displayName: 'The Oxy Collective',
        },
      }),
      identityName: 'Nate',
    });

    expect(getByTestId('approval-approving-with').textContent).toBe("Nate's Oxy identity");
    expect(getByTestId('approval-acting-as').textContent).toBe('The Oxy Collective');
    expect(container.textContent).toContain('Approving with');
    expect(container.textContent).toContain('Mention will act as');
  });

  it('never implies the identity became the organization', () => {
    const { container, getByTestId } = renderRequest({
      info: makeInfo({
        subjectAccount: { id: 'acct-9', username: 'oxycollective', displayName: 'The Oxy Collective' },
      }),
    });

    // The identity is stated as the approver, the account only as what the app
    // will act as — and it says so in words.
    expect(getByTestId('approval-approving-with').textContent).toContain('Nate');
    expect(getByTestId('approval-approving-with').textContent).not.toContain('Oxy Collective');
    expect(container.textContent).toContain("Your identity doesn't change");
  });

  it('falls back to the delegated account handle when it has no display name', () => {
    const { getByTestId } = renderRequest({
      info: makeInfo({ subjectAccount: { id: 'acct-9', username: 'oxycollective' } }),
    });

    expect(getByTestId('approval-acting-as').textContent).toBe('@oxycollective');
  });

  it('does not double-prefix a federated delegated account handle', () => {
    const { getByTestId } = renderRequest({
      info: makeInfo({
        subjectAccount: { id: 'acct-9', username: 'alice@mastodon.social' },
      }),
    });

    expect(getByTestId('approval-acting-as').textContent).toBe('alice@mastodon.social');
  });

  it('names the identity generically when the vault identity has no name yet', () => {
    const { getByTestId } = renderRequest({
      info: makeInfo({
        subjectAccount: { id: 'acct-9', username: 'oxycollective', displayName: 'The Oxy Collective' },
      }),
      identityName: null,
    });

    expect(getByTestId('approval-approving-with').textContent).toBe('Your Oxy identity');
  });

  it('renders NOTHING an untrusted payload asserted about itself', () => {
    // A phishing QR self-asserts an app name, an origin AND a plausible client
    // label. The parser hands back only the code, and the screen renders only
    // what the server resolved from it.
    const parsed = parseApprovalLink(
      'oxycommons://approve?v=1&code=abc123&app=EvilCorp&origin=https%3A%2F%2Fevil.example' +
        '&client=Safari%20on%20iPhone&nonce=n1',
    );
    expect(parsed).toEqual({ ok: true, code: 'abc123' });

    const { container } = renderRequest();

    expect(container.textContent).not.toContain('EvilCorp');
    expect(container.textContent).not.toContain('evil.example');
    expect(container.textContent).not.toContain('Safari on iPhone');
    expect(container.textContent).toContain('Sign in to Mention');
    expect(container.textContent).toContain('mention.earth');
    expect(container.textContent).toContain('Chrome on Windows');
  });

  it('warns loudly when the request origin could not be verified', () => {
    const { container } = renderRequest({ info: makeInfo({ originVerified: false }) });

    expect(container.textContent).toContain("We couldn't verify this sign-in");
    // The reassuring "official app" treatment is withheld in this state.
    expect(container.textContent).not.toContain('Official Oxy app');
  });

  it('states the baseline the app receives when the request carries no scopes', () => {
    const { container } = renderRequest({ info: makeInfo({ scopes: [] }) });

    expect(container.textContent).toContain('Mention will receive');
    expect(container.textContent).toContain('Your identity, name, and profile picture');
  });

  it('shows an unknown scope verbatim instead of dropping it', () => {
    const { container } = renderRequest({ info: makeInfo({ scopes: ['ledger:write'] }) });

    expect(container.textContent).toContain('ledger:write');
  });

  it('explains a device that cannot confirm, and still approves nothing', () => {
    const { container } = renderRequest({
      confirmationIssue: { kind: 'unavailable', reason: 'no_enrollment' },
    });

    expect(container.textContent).toContain('no biometrics or screen lock');
    expect(container.textContent).toContain('device settings');
    // The explanation offers no bypass; the route-level Dialog remains the
    // single owner of every answer action.
    expect(container.textContent).not.toContain('Continue without confirming');
  });

  it('distinguishes a cancelled prompt from a device that cannot ask', () => {
    const { container } = renderRequest({ confirmationIssue: { kind: 'declined' } });

    expect(container.textContent).toContain('Confirmation cancelled');
    expect(container.textContent).toContain('Nothing was approved');
  });

  it('explains a locked-out sensor', () => {
    const { container } = renderRequest({ confirmationIssue: { kind: 'lockout' } });

    expect(container.textContent).toContain('locked biometrics');
  });
});
