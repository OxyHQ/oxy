/**
 * The mail an account's email receives (ADR 0030): a sign-up code; a sign-in
 * code and link; a re-verification code; the code that proves a new address;
 * and security notices. Plain text and a minimal HTML
 * part, from `noreply@`.
 *
 * The relay is loaded on first send: `smtp.outbound` pulls in the mailbox and
 * attachment stack, which the routes that only mint codes have no use for.
 */
import type { ReauthAction } from '@oxy.so/contracts';
import { getAuthWebOrigin } from '../config/env';

export async function sendSystem(message: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  const { smtpOutbound } = await import('./smtp.outbound.js');
  await smtpOutbound.sendSystem(message);
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

export function htmlPage(paragraphs: string[], code?: string): string {
  const body = paragraphs.map(
    (paragraph) => `<p style="margin:0 0 16px">${escapeHtml(paragraph)}</p>`,
  );
  if (code) {
    body.splice(
      1,
      0,
      `<p style="margin:0 0 16px;font-size:32px;font-weight:600;letter-spacing:8px;font-family:ui-monospace,monospace">${escapeHtml(code)}</p>`,
    );
  }
  return (
    '<!doctype html><html><body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:16px;line-height:24px;color:#111">' +
    `<div style="max-width:480px;margin:0 auto">${body.join('')}</div></body></html>`
  );
}

/** The 6-digit code that confirms a new account's email. */
export async function sendVerificationCode(to: string, code: string): Promise<void> {
  const subject = `${code} is your Oxy code`;
  const lead = 'Enter this code to confirm the email of your new Oxy account:';
  const tail = [
    'It expires in 10 minutes.',
    "If you didn't ask for it, you can ignore this email. No account is created without the code.",
  ];
  await sendSystem({
    to,
    subject,
    text: [lead, '', code, '', ...tail].join('\n'),
    html: htmlPage([lead, ...tail], code),
  });
}

/**
 * A sign-in email: the 6-digit code and a one-use link to auth.oxy.so, either
 * of which signs the person in. The link's token travels in the URL FRAGMENT,
 * which a browser never sends to a server or in a `Referer`, so it reaches only
 * the auth.oxy.so page that reads it. Nothing about the account but its
 * username is in the email, and not even that when the address holds several
 * accounts: which one is chosen after the code.
 */
export async function sendSignInEmail(
  to: string,
  message: { code: string; linkToken: string; username: string | null; severalAccounts?: boolean },
): Promise<void> {
  const link = `${getAuthWebOrigin()}/email-signin#t=${encodeURIComponent(message.linkToken)}`;
  const greeting = message.username ? `Hi @${message.username},` : 'Hi,';
  const lead = message.severalAccounts
    ? 'Enter this code in the app to sign in to Oxy. Then choose which of the accounts on this email to use:'
    : 'Enter this code in the app to sign in to Oxy:';
  const tail = [
    `Or open this link in the same browser: ${link}`,
    'The code expires in 10 minutes and the link in 15.',
    "If you didn't ask to sign in, you can ignore this email: nobody gets into your account without the code or this link.",
  ];
  await sendSystem({
    to,
    subject: `${message.code} is your Oxy sign-in code`,
    text: [greeting, '', lead, '', message.code, '', ...tail].join('\n'),
    html: htmlPage([greeting, lead, ...tail], message.code).replace(
      escapeHtml(link),
      `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`,
    ),
  });
}

/**
 * The code that proves the address a signed-in account moves its email to.
 * Sent to the NEW address; names the account, since its owner asked.
 */
export async function sendEmailChangeCode(
  to: string,
  code: string,
  username: string | null,
): Promise<void> {
  const greeting = username ? `Hi @${username},` : 'Hi,';
  const lead = 'Enter this code to use this email for your Oxy account:';
  const tail = [
    'It expires in 10 minutes.',
    "If you didn't ask for it, you can ignore this email: nothing changes without the code.",
  ];
  await sendSystem({
    to,
    subject: `${code} is your Oxy code`,
    text: [greeting, '', lead, '', code, '', ...tail].join('\n'),
    html: htmlPage([greeting, lead, ...tail], code),
  });
}

const REAUTH_ACTION_TEXT: Record<ReauthAction, string> = {
  change_password: 'set, change or remove the password of your Oxy account',
  change_email: 'change or remove the email of your Oxy account',
  totp: 'change the authenticator app of your Oxy account',
  link_commons: 'link your Oxy account to Commons (this email will be removed from it)',
  delete_account: 'DELETE your Oxy account permanently',
  credentials_manage: 'manage autonomous credentials for an account you govern',
  supervision: 'confirm a supervised-account safety change',
  supervision_purchase: 'decide the exact purchase requested by a supervised account',
};

/** A code a signed-in person enters to confirm ONE named sensitive change. */
export async function sendReauthCode(
  to: string,
  code: string,
  username: string | null,
  action: ReauthAction,
): Promise<void> {
  const greeting = username ? `Hi @${username},` : 'Hi,';
  const lead = `Enter this code to ${REAUTH_ACTION_TEXT[action]}. It works for nothing else:`;
  const tail = [
    'It expires in 10 minutes.',
    "If you didn't ask for it, someone may be signed in to your account: sign out of every device from your account settings.",
  ];
  await sendSystem({
    to,
    subject: `${code} is your Oxy confirmation code`,
    text: [greeting, '', lead, '', code, '', ...tail].join('\n'),
    html: htmlPage([greeting, lead, ...tail], code),
  });
}

export type SecurityNotice =
  | 'password_set'
  | 'password_changed'
  | 'password_removed'
  | 'email_added'
  | 'email_changed'
  | 'email_removed'
  | 'totp_enabled'
  | 'totp_disabled'
  | 'backup_codes_regenerated'
  | 'commons_linked';

const SECURITY_NOTICE_TEXT: Record<SecurityNotice, { subject: string; body: string }> = {
  password_set: {
    subject: 'A password was added to your Oxy account',
    body: 'A password was just added to your Oxy account.',
  },
  password_changed: {
    subject: 'Your Oxy password was changed',
    body: 'The password of your Oxy account was just changed.',
  },
  password_removed: {
    subject: 'The password of your Oxy account was removed',
    body: 'The password of your Oxy account was just removed. You now sign in with a code or a link sent to this email.',
  },
  email_added: {
    subject: 'This email now belongs to an Oxy account',
    body: 'This address was just added to your Oxy account. Sign-in codes and security notices now come here.',
  },
  email_changed: {
    subject: 'The email of your Oxy account was changed',
    body: 'The email of your Oxy account was just changed to another address. This one no longer signs in to it or receives its notices.',
  },
  email_removed: {
    subject: 'The email of your Oxy account was removed',
    body: 'This address was just removed from your Oxy account. It no longer signs in to it or receives its notices, and the account can only be recovered with its password.',
  },
  totp_enabled: {
    subject: 'An authenticator app was turned on',
    body: 'An authenticator app was just turned on for your Oxy account. Signing in now also asks for its code.',
  },
  totp_disabled: {
    subject: 'The authenticator app was turned off',
    body: 'The authenticator app of your Oxy account was just turned off. Signing in no longer asks for its code.',
  },
  backup_codes_regenerated: {
    subject: 'New backup codes for your Oxy account',
    body: 'New backup codes were just created for your Oxy account. The old ones no longer work.',
  },
  commons_linked: {
    subject: 'Your Oxy account is now linked to Commons',
    body: 'Your Oxy account was just linked to Commons. From now on you sign in with Commons, and this email address is no longer part of the account.',
  },
};

/** Tell the account's email that a security setting changed. Only the username is named. */
export async function sendSecurityNotice(
  to: string,
  notice: SecurityNotice,
  username: string | null,
): Promise<void> {
  const text = SECURITY_NOTICE_TEXT[notice];
  const paragraphs = [
    username ? `Hi @${username},` : 'Hi,',
    text.body,
    `If it wasn't you, sign in at ${getAuthWebOrigin()} and secure your account now.`,
  ];
  await sendSystem({
    to,
    subject: text.subject,
    text: paragraphs.join('\n\n'),
    html: htmlPage(paragraphs),
  });
}

export async function sendAccountInvitation(
  to: string,
  token: string,
  role: string,
): Promise<void> {
  const paragraphs = [
    `You have been invited to an Oxy account as ${role}.`,
    `Review and accept: https://accounts.oxy.so/invitation#${token}`,
    'This single-use link expires in seven days. Choose the Oxy account that should receive access; its email may differ from this address. No access is granted until you confirm.',
  ];
  await sendSystem({
    to,
    subject: 'Oxy account invitation',
    text: paragraphs.join('\n\n'),
    html: htmlPage(paragraphs),
  });
}
