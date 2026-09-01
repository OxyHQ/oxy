import type React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxyhq-services';
import { __setMockSearchParams } from '@/__mocks__/expo-router';
import { LocaleProvider } from '@/lib/i18n/locale-context';

// The device gate is irrelevant to the answers under test here (denying never
// prompts), but the screen's hook imports it — stub it so the real
// `expo-local-authentication` native module is never loaded.
jest.mock('@/lib/biometricAuth', () => ({
  requestLocalConfirmation: jest.fn(async () => ({ outcome: 'confirmed' })),
}));

/**
 * Bloom's bottom sheet, reduced to its contract with this screen: an imperative
 * control that is STABLE across renders (the screen opens from a mount effect
 * keyed on it) and a surface that renders whatever the screen puts in it.
 *
 * `close()` is deliberately inert. That is the point of the dismissal test: the
 * screen must answer the request with nothing at all when the sheet is
 * dismissed, so there is no sheet behaviour left to stand in for an answer.
 */
jest.mock('@oxyhq/bloom/dialog', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof import('react');
  interface MockControl {
    open: jest.Mock;
    close: jest.Mock;
  }
  return {
    useDialogControl: (): MockControl => {
      const ref = R.useRef<MockControl | null>(null);
      if (!ref.current) {
        ref.current = { open: jest.fn(), close: jest.fn() };
      }
      return ref.current;
    },
    Dialog: ({
      children,
      actions,
    }: {
      children: React.ReactNode;
      actions?: Array<{
        label: string;
        onPress?: () => void;
        disabled?: boolean;
      }>;
    }) =>
      R.createElement(
        'div',
        null,
        children,
        actions?.map((action) =>
          R.createElement(
            'button',
            {
              key: action.label,
              type: 'button',
              'aria-label': action.label,
              disabled: action.disabled,
              onClick: action.onPress,
            },
            action.label,
          ),
        ),
      ),
  };
});

// Imported AFTER the mocks so the screen binds to them.
// eslint-disable-next-line import/first
import ApproveSignInScreen from '@/app/approve';

/** The request exactly as the SERVER resolves it from the authorize code. */
const SERVER_INFO = {
  application: {
    id: 'app-1',
    name: 'Mention',
    type: 'first_party',
    isOfficial: true,
    isInternal: false,
    scopes: ['profile:read'],
    developerName: 'Oxy',
  },
  scopes: ['profile:read'],
  boundOrigin: 'https://mention.earth',
  originVerified: true,
  requesterLabel: 'Chrome on Windows',
  purpose: 'device_sign_in',
  subjectAccount: null,
  expiresAt: Date.now() + 300_000,
  status: 'pending',
};

function installServices(info: Record<string, unknown> = SERVER_INFO) {
  const services = {
    getCommonsApprovalInfo: jest.fn(async () => info),
    markCommonsApprovalOpened: jest.fn(async () => undefined),
    approveCommonsSignIn: jest.fn(async () => ({ success: true })),
    denyCommonsSignIn: jest.fn(async () => ({ success: true })),
  };
  __setOxyState({
    isAuthenticated: true,
    user: { username: 'nate', name: { displayName: 'Nate' } },
    oxyServices: services,
  });
  return services;
}

function renderScreen() {
  return render(
    <LocaleProvider>
      <ApproveSignInScreen />
    </LocaleProvider>,
  );
}

describe('ApproveSignInScreen', () => {
  beforeEach(() => {
    __resetOxyState();
    __setMockSearchParams({ code: 'code-1' });
  });

  it('shows the client the SERVER named, not anything the link asserted', async () => {
    installServices();
    const { container, findByText } = renderScreen();

    await findByText('Chrome on Windows');
    expect(container.textContent).toContain('Sign in to Mention');
    expect(container.textContent).toContain('mention.earth');
  });

  it('omits the client line when the server has no client to describe', async () => {
    installServices({ ...SERVER_INFO, requesterLabel: null });
    const { container, findByText, queryByTestId } = renderScreen();

    await findByText('Sign in to Mention');
    expect(queryByTestId('approval-requester')).toBeNull();
    expect(container.textContent).not.toContain('Chrome on Windows');
  });

  it('owns exactly one confirm, one explicit rejection, and one cancel action', async () => {
    installServices();
    const { findByRole, getAllByRole } = renderScreen();

    await findByRole('button', { name: 'Confirm identity' });
    expect(getAllByRole('button').map((button) => button.textContent)).toEqual(
      expect.arrayContaining(['Confirm identity', "This wasn't me", 'Cancel']),
    );
  });

  it('starts confirmation directly from the Dialog primary action', async () => {
    const services = installServices();
    const { findByRole } = renderScreen();

    fireEvent.click(await findByRole('button', { name: 'Confirm identity' }));

    await waitFor(() => expect(services.approveCommonsSignIn).toHaveBeenCalledTimes(1));
    expect(services.denyCommonsSignIn).not.toHaveBeenCalled();
  });

  it('locks every answer while approval is in flight and reports honest progress', async () => {
    const services = installServices();
    services.approveCommonsSignIn.mockImplementation(() => new Promise(() => undefined));
    const { findByRole, getByRole } = renderScreen();

    fireEvent.click(await findByRole('button', { name: 'Confirm identity' }));

    const confirming = await findByRole('button', { name: 'Confirming identity…' });
    expect((confirming as HTMLButtonElement).disabled).toBe(true);
    expect((getByRole('button', { name: "This wasn't me" }) as HTMLButtonElement).disabled).toBe(true);
    expect((getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('denies as not_me from "This wasn\'t me", and says what was recorded', async () => {
    const services = installServices();
    const { container, findByText } = renderScreen();

    fireEvent.click(await findByText("This wasn't me"));

    await waitFor(() => expect(container.textContent).toContain('Sign-in stopped'));
    expect(services.denyCommonsSignIn).toHaveBeenCalledWith('code-1', 'not_me');
    // Honest about the record it just created — and nothing beyond it.
    expect(container.textContent).toContain("we've recorded that you didn't start it");
    expect(container.textContent).toContain("It can't be approved now");
  });

  it('answers nothing when the sheet is dismissed', async () => {
    const services = installServices();
    const { container, findByLabelText } = renderScreen();

    fireEvent.click(await findByLabelText('Close'));

    // A dismissal is a CANCEL: no denial is sent, with or without a reason, and
    // no approval either. The request is simply left pending.
    expect(services.denyCommonsSignIn).not.toHaveBeenCalled();
    expect(services.approveCommonsSignIn).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Sign-in stopped');
  });

  it('never asks the server for a request it was given no code for', async () => {
    const services = installServices();
    __setMockSearchParams({});
    const { findByText } = renderScreen();

    await findByText('No sign-in code was provided.');
    expect(services.getCommonsApprovalInfo).not.toHaveBeenCalled();
    expect(services.denyCommonsSignIn).not.toHaveBeenCalled();
  });
});
