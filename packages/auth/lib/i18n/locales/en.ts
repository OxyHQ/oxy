import type { LocaleDict } from '../types';

/**
 * English (en-US) copy for the IdP's own pages (authorize, device approval, MCP
 * linking, the language picker). Everything the SDK renders — sign-in,
 * sign-up, consent — is `@oxy.so/core`'s, in every locale.
 */
const en: LocaleDict = {
  language: {
    picker: {
      label: 'Language',
      ariaLabel: 'Choose language',
    },
  },
  mcpLink: {
    title: 'Connect this account to {{client}}',
    subtitle: 'Approving adds {{handle}} to the {{app}} connection your assistant already has. Your other accounts are not affected.',
    scopesTitle: 'What the connection may do as this account',
    revokeHint: 'This account gets its own authorization. You can revoke it at any time from your Oxy settings, without touching the other accounts on the connection.',
    alreadyLinked: '{{handle}} is already connected. Approving again just refreshes it.',
    approve: 'Connect this account',
    useAnother: 'Use a different account',
    thisAccount: 'this account',
    theAssistant: 'your assistant',
    connectedTitle: 'Account connected',
    connectedDesc: '{{handle}} is now available in {{client}}. Go back and ask it to switch to this account.',
    noRequestTitle: 'No connection request',
    noRequestDesc: 'This page opens from a link your assistant generates. Ask it to connect another account.',
    unavailableTitle: 'This link is no longer valid',
    unavailableDesc: 'Account links can only be used once and expire quickly. Ask your assistant for a new one.',
    errors: {
      loadFailed: 'Unable to load this connection request.',
      approveFailed: 'The account could not be connected. Ask your assistant for a new link.',
      switchFailed: 'That account could not be selected. Sign in again to continue.',
    },
  },
  device: {
    noRequestTitle: 'No sign-in request',
    noRequestDesc: 'This page opens from the link a device shows you when it asks you to sign in — for example "codea login" in a terminal.',
    unavailableTitle: "This sign-in request can't be used",
    loadFailed: 'This sign-in request could not be found. Start the sign-in again on your device.',
    codeHint: 'Only continue if this code matches the one your device is showing:',
    ackVerified: 'I started this sign-in myself in {{app}}.',
    ackUnverified: "We couldn't verify where this request came from. I understand the risk and started this sign-in myself in {{app}}.",
    approvedTitle: "You're signed in",
    approvedDesc: '{{app}} will continue on its own. You can close this tab.',
    deniedTitle: 'Sign-in declined',
    deniedDesc: 'Nothing was authorized. You can close this tab.',
    errors: {
      approveFailed: 'Could not complete sign-in. Start it again on your device.',
      noToken: 'Your session expired. Sign in again to continue.',
      switchFailed: 'That account could not be selected. Sign in again to continue.',
    },
  },
  authorize: {
    title: 'Continue to {{app}}',
    cancel: 'Cancel',
    signingIn: 'Signing you in…',
    relayFailedTitle: 'Sign-in could not be completed',
    silentUnsupportedTitle: 'Oxy always asks you first',
    silentUnsupportedDesc: 'This app asked to sign you in without showing you anything. Oxy does not authorize access that way. Go back to the app and start sign-in again.',
    requestTitle: 'Authorization request',
    requestUnavailable: "We couldn't load the details of this request.",
    completeTitle: 'Authorization complete',
    deniedTitle: 'Authorization denied',
    completeChild: 'This window will close automatically.',
    completeDesc: 'You can close this window.',
    deniedDesc: 'The request was denied. You can close this window.',
    noRequestTitle: 'No authorization request',
    noRequestDesc: 'Open the app you want to sign in to and try again. The authorization request starts there.',
    goToSignIn: 'Go to sign in',
    commons: {
      description: 'Approve this in Oxy on your phone. You do not need to sign in here first.',
      openOnThisDevice: 'I have Oxy on this device',
      signInHere: 'Sign in on this device instead',
      errors: {
        startFailed: "We couldn't start this request. Please try again.",
        requestExpired: 'This request expired before it was approved.',
        unreachable: "We lost contact with this request and couldn't tell whether it was approved.",
        finalizeFailed: "We couldn't complete this authorization. Start a new request to try again.",
        redirectMismatch: "This authorization couldn't be delivered safely. Go back to the app and start again.",
      },
    },
  },
};

export default en;
