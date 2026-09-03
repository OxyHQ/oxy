/**
 * `OxyConsentScreen` — the unified OAuth consent surface. These tests exercise
 * the pure presentational contract: scopes render, privacy/terms links appear
 * only when supplied, allow/deny fire their handlers, `busy` disables both
 * actions, and the account badge follows the display-name rule (`displayName`
 * else `handle`).
 */
import { render, fireEvent } from '@testing-library/react';
import {
  OxyConsentScreen,
  type OxyConsentApplication,
  type OxyConsentScreenProps,
} from '../OxyConsentScreen';

jest.mock('../logo/LogoIcon', () => ({ LogoIcon: () => null }));

const baseApp: OxyConsentApplication = { name: 'Acme Notes' };

function renderScreen(props: Partial<OxyConsentScreenProps> = {}) {
  const onAllow = jest.fn();
  const onDeny = jest.fn();
  const view = render(
    <OxyConsentScreen
      application={props.application ?? baseApp}
      scopes={props.scopes ?? ['openid', 'profile']}
      user={props.user}
      resource={props.resource}
      onAllow={props.onAllow ?? onAllow}
      onDeny={props.onDeny ?? onDeny}
      busy={props.busy}
      error={props.error}
    />,
  );
  return { ...view, onAllow: props.onAllow ?? onAllow, onDeny: props.onDeny ?? onDeny };
}

describe('OxyConsentScreen', () => {
  it('renders every requested scope with a friendly label and falls back to the raw scope for unknown ones', () => {
    const { getByTestId } = renderScreen({ scopes: ['openid', 'files:write', 'custom:thing'] });

    expect(getByTestId('consent-scope-openid').textContent).toContain('Confirm your identity');
    expect(getByTestId('consent-scope-files:write').textContent).toContain('Upload and modify your files');
    // Unknown scope → the raw scope string is shown, never an empty row.
    expect(getByTestId('consent-scope-custom:thing').textContent).toContain('custom:thing');
  });

  it('renders human labels for the scope ids the API actually issues (profile:read / email:read)', () => {
    const { getByTestId } = renderScreen({ scopes: ['profile:read', 'email:read'] });

    const profileRow = getByTestId('consent-scope-profile:read');
    const emailRow = getByTestId('consent-scope-email:read');
    expect(profileRow.textContent).toContain('Read your basic profile');
    expect(emailRow.textContent).toContain('Read your email address');
    // The raw scope id never reaches the person deciding what to grant.
    expect(profileRow.textContent).not.toContain('profile:read');
    expect(emailRow.textContent).not.toContain('email:read');
  });

  it('collapses scopes that resolve to the same permission into a single row', () => {
    const { getByTestId, queryByTestId } = renderScreen({ scopes: ['profile', 'profile:read'] });

    // First scope wins the row; the synonym does not add a duplicate sentence.
    expect(getByTestId('consent-scope-profile').textContent).toContain('Read your basic profile');
    expect(queryByTestId('consent-scope-profile:read')).toBeNull();
  });

  it('keeps an unknown scope alongside known ones instead of dropping the permission', () => {
    const { getByTestId } = renderScreen({ scopes: ['profile:read', 'acme:teleport'] });

    expect(getByTestId('consent-scope-profile:read').textContent).toContain('Read your basic profile');
    expect(getByTestId('consent-scope-acme:teleport').textContent).toContain('acme:teleport');
  });

  it('shows the basic-permissions fallback when no scopes are requested', () => {
    const { getByTestId, queryByTestId } = renderScreen({ scopes: [] });
    expect(getByTestId('consent-scope-basic').textContent).toContain('Sign you in and read your basic profile');
    expect(queryByTestId('consent-scope-openid')).toBeNull();
  });

  it('renders the provenance line for an official application', () => {
    const { getByTestId } = renderScreen({ application: { name: 'Oxy Console', isOfficial: true } });
    expect(getByTestId('consent-provenance').textContent).toContain('Official Oxy application');
  });

  it('renders "Published by …" provenance for a third-party app with a developer', () => {
    const { getByTestId } = renderScreen({
      application: { name: 'Third Party', developerName: 'Widgets Inc' },
    });
    expect(getByTestId('consent-provenance').textContent).toContain('Widgets Inc');
  });

  it('omits privacy/terms links when the application does not supply them', () => {
    const { queryByTestId } = renderScreen();
    expect(queryByTestId('consent-link-privacy')).toBeNull();
    expect(queryByTestId('consent-link-terms')).toBeNull();
  });

  it('renders privacy and terms links when supplied (field 2b)', () => {
    const { getByTestId } = renderScreen({
      application: {
        name: 'Acme Notes',
        privacyPolicyUrl: 'https://acme.example/privacy',
        termsUrl: 'https://acme.example/terms',
      },
    });
    expect(getByTestId('consent-link-privacy')).not.toBeNull();
    expect(getByTestId('consent-link-terms')).not.toBeNull();
  });

  it('fires onAllow and onDeny from the decision buttons', () => {
    const { getByTestId, onAllow, onDeny } = renderScreen();

    fireEvent.click(getByTestId('consent-allow'));
    expect(onAllow).toHaveBeenCalledTimes(1);

    fireEvent.click(getByTestId('consent-deny'));
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it('disables both actions while busy', () => {
    const { getByTestId, onAllow, onDeny } = renderScreen({ busy: true });

    const allow = getByTestId('consent-allow') as HTMLButtonElement;
    const deny = getByTestId('consent-deny') as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    expect(deny.disabled).toBe(true);

    // A disabled jsdom <button> does not fire click — the handlers stay untouched.
    fireEvent.click(allow);
    fireEvent.click(deny);
    expect(onAllow).not.toHaveBeenCalled();
    expect(onDeny).not.toHaveBeenCalled();
  });

  it('renders the authorizing account using the display name when present', () => {
    const { getByTestId } = renderScreen({
      user: { displayName: '  Alice A  ', handle: 'alice', avatarUri: 'file-1' },
    });
    expect(getByTestId('consent-account-name').textContent).toBe('Alice A');
  });

  it('renders the exact MCP app, protected resource, account id and catalog-derived write actions', () => {
    const { getByTestId } = renderScreen({
      scopes: ['email.read', 'email.send'],
      user: {
        accountId: 'account-mail-1',
        displayName: 'Oxy Mail',
        handle: 'oxy-mail-account',
      },
      resource: {
        application: { name: 'Inbox', iconUrl: 'inbox-icon' },
        uri: 'https://mcp.inbox.oxy.so',
        writeActions: [{
          name: 'sendEmail',
          version: '1.0.0',
          description: 'Send an email from the selected mailbox.',
          requiredCapabilities: ['email.send'],
          effect: 'external',
        }],
      },
    });

    expect(getByTestId('consent-resource-app').textContent).toBe('Inbox');
    expect(getByTestId('consent-resource-uri').textContent).toBe('https://mcp.inbox.oxy.so');
    expect(getByTestId('consent-account-id').textContent).toContain('account-mail-1');
    expect(getByTestId('consent-scope-email.send').textContent).toContain('email.send');
    expect(getByTestId('consent-write-action-sendEmail').textContent).toContain(
      'Send an email from the selected mailbox.',
    );
    expect(getByTestId('consent-write-action-sendEmail').textContent).toContain('External');
  });

  it('falls back to the handle when the account has no display name (D5)', () => {
    const { getByTestId } = renderScreen({ user: { handle: 'bob' } });
    expect(getByTestId('consent-account-name').textContent).toBe('bob');
  });

  it('omits the account badge entirely when no user is supplied', () => {
    const { queryByTestId } = renderScreen({ user: undefined });
    expect(queryByTestId('consent-account')).toBeNull();
  });

  it('renders a blocking error when supplied', () => {
    const { getByTestId } = renderScreen({ error: 'This request has expired.' });
    expect(getByTestId('consent-error').textContent).toContain('This request has expired.');
  });
});
