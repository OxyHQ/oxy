import type { LocaleDict } from '../types';

/**
 * English (en-US) translation dictionary for the auth web app.
 *
 * Keys are namespaced by feature area. `signin.*`, `signup.*`, `recover.*`
 * etc. live in `@oxyhq/core` so they can be shared across web and native
 * surfaces; this dict only carries auth-app-specific strings (settings,
 * sessions, linked accounts, language picker, etc.).
 */
const en: LocaleDict = {
  common: {
    cancel: 'Cancel',
    save: 'Save',
    continue: 'Continue',
    back: 'Back',
    signOut: 'Sign out',
    delete: 'Delete',
    loading: 'Loading…',
    error: 'Error',
    success: 'Done',
  },

  app: {
    name: 'Oxy',
    title: 'Sign in · Oxy',
  },

  language: {
    picker: {
      label: 'Language',
      ariaLabel: 'Choose language',
    },
  },

  footer: {
    terms: 'Terms',
    privacy: 'Privacy',
    help: 'Help',
    copyright: '© {{year}} Oxy',
  },

  settings: {
    title: 'Account settings',
    sections: {
      password: 'Password',
      sessions: 'Sessions',
      linkedAccounts: 'Linked accounts',
      language: 'Language',
    },
    password: {
      title: 'Change password',
      currentLabel: 'Current password',
      newLabel: 'New password',
      confirmLabel: 'Confirm new password',
      submit: 'Change password',
      success: 'Password changed.',
      error: 'Could not change password.',
    },
    sessions: {
      title: 'Active sessions',
      subtitle: 'Devices currently signed in to your account.',
      currentBadge: 'This device',
      revoke: 'Sign out',
      revokeAll: 'Sign out everywhere else',
      revokedToast: 'Session ended.',
      empty: 'No other active sessions.',
    },
    linkedAccounts: {
      title: 'Linked accounts',
      subtitle: 'Third-party providers connected to your Oxy account.',
      link: 'Link',
      unlink: 'Unlink',
      none: 'No linked accounts.',
    },
  },

  mcpLink: {
    title: 'Connect this account to {{client}}',
    subtitle:
      'Approving adds {{handle}} to the {{app}} connection your assistant already has. Your other accounts are not affected.',
    scopesTitle: 'What the connection may do as this account',
    revokeHint:
      'This account gets its own authorization. You can revoke it at any time from your Oxy settings, without touching the other accounts on the connection.',
    alreadyLinked: '{{handle}} is already connected. Approving again just refreshes it.',
    approve: 'Connect this account',
    useAnother: 'Use a different account',
    thisAccount: 'this account',
    theAssistant: 'your assistant',
    connectedTitle: 'Account connected',
    connectedDesc:
      '{{handle}} is now available in {{client}}. Go back and ask it to switch to this account.',
    noRequestTitle: 'No connection request',
    noRequestDesc:
      'This page opens from a link your assistant generates. Ask it to connect another account.',
    unavailableTitle: 'This link is no longer valid',
    unavailableDesc:
      'Account links can only be used once and expire quickly. Ask your assistant for a new one.',
    errors: {
      loadFailed: 'Unable to load this connection request.',
      approveFailed: 'The account could not be connected. Ask your assistant for a new link.',
      switchFailed: 'That account could not be selected. Sign in again to continue.',
    },
  },
  authorize: {
    title: 'Continue to {{app}}',
    subtitle:
      'Use your Oxy account to sign in to {{app}}. Review what this connection means before you continue.',
    benefits: {
      title: 'What this means',
      secure: 'Sign in securely with your Oxy account — no new password needed',
      oneAccount: 'One account across every Oxy app',
      youControl: 'You choose what you share, and you can revoke access anytime',
    },
    provenance: {
      title: 'Who is requesting access',
      official: 'Official Oxy application',
      internal: 'Internal Oxy application',
      developer: 'Published by {{developer}}',
      thirdParty: 'Third-party application',
    },
    permissions: {
      title: 'Permissions requested',
      basic: 'Sign you in and read your basic profile',
    },
    continue: 'Continue to {{app}}',
    cancel: 'Cancel',
    notYou: 'Not you?',
    switchAccount: 'Use a different account',
    disclaimer:
      'By continuing, {{app}} will be able to sign in with your Oxy account. You can manage connected apps anytime in your Oxy account settings.',
    expiresAt: 'Request expires at {{time}}.',
    signingIn: 'Signing you in…',
    // Popup delivery reported a failure to the app that opened this window.
    relayFailedTitle: 'Sign-in could not be completed',
    // A request that asked to be completed without showing anything
    // (`prompt=none`). Oxy never authorizes without asking, so it is refused.
    silentUnsupportedTitle: 'Oxy always asks you first',
    silentUnsupportedDesc:
      'This app asked to sign you in without showing you anything. Oxy does not authorize access that way. Go back to the app and start sign-in again.',
    requestTitle: 'Authorization request',
    requestUnavailable: "We couldn't load the details of this request.",
    completeTitle: 'Authorization complete',
    deniedTitle: 'Authorization denied',
    completeChild: 'This window will close automatically.',
    completeDesc: 'You can close this window.',
    deniedDesc: 'The request was denied. You can close this window.',
    noRequestTitle: 'No authorization request',
    noRequestDesc:
      'Open the app you want to sign in to and try again. The authorization request starts there.',
    goToSignIn: 'Go to sign in',
    // The Commons lane: approving the authorization directly in Oxy, without
    // signing in on this site first. Progress and headline copy come from
    // `@oxyhq/core`'s shared `accountSwitcher.*` dictionary, so only the
    // lane-specific strings live here.
    commons: {
      description:
        'Approve this in Oxy on your phone. You do not need to sign in here first.',
      openOnThisDevice: 'I have Oxy on this device',
      signInHere: 'Sign in on this device instead',
      errors: {
        startFailed: "We couldn't start this request. Please try again.",
        requestExpired: 'This request expired before it was approved.',
        unreachable: "We lost contact with this request and couldn't tell whether it was approved.",
        finalizeFailed:
          "We couldn't complete this authorization. Start a new request to try again.",
        redirectMismatch:
          "This authorization couldn't be delivered safely. Go back to the app and start again.",
      },
    },
  },
};

export default en;
