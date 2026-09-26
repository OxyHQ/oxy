/**
 * The mail a recovery email receives (ADR 0029 D3): a verification code, or —
 * when someone tries to create an account with an address that already has
 * one — a notice pointing at recovery instead of a code. Plain text and a
 * minimal HTML part, from `noreply@`.
 *
 * The relay is loaded on first send: `smtp.outbound` pulls in the mailbox and
 * attachment stack, which the routes that only mint codes have no use for.
 */
import type { EmailVerificationPurpose } from '@oxy.so/contracts';
import { getAuthWebOrigin } from '../config/env';

async function sendSystem(message: { to: string; subject: string; text: string; html: string }): Promise<void> {
  const { smtpOutbound } = await import('./smtp.outbound.js');
  await smtpOutbound.sendSystem(message);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function htmlPage(paragraphs: string[], code?: string): string {
  const body = paragraphs.map((paragraph) => `<p style="margin:0 0 16px">${escapeHtml(paragraph)}</p>`);
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

/** The 6-digit code for a sign-up or a recovery. */
export async function sendVerificationCode(to: string, code: string, purpose: EmailVerificationPurpose): Promise<void> {
  const subject = purpose === 'signup' ? `${code} is your Oxy code` : `${code} is your Oxy recovery code`;
  const lead =
    purpose === 'signup'
      ? 'Enter this code to confirm the recovery email of your new Oxy account:'
      : 'Enter this code to get back into your Oxy account and add a new passkey:';
  const tail = [
    'It expires in 10 minutes.',
    purpose === 'signup'
      ? "If you didn't ask for it, you can ignore this email. No account is created without the code."
      : "If you didn't ask for it, you can ignore this email: nobody gets into your account without the code.",
  ];
  await sendSystem({
    to,
    subject,
    text: [lead, '', code, '', ...tail].join('\n'),
    html: htmlPage([lead, ...tail], code),
  });
}

/** Someone tried to create an account with an address that already has one. */
export async function sendAccountExistsNotice(to: string): Promise<void> {
  const recoverUrl = `${getAuthWebOrigin()}/recover`;
  const paragraphs = [
    'Someone tried to create an Oxy account with this email, but it is already the recovery email of an account.',
    `If it was you and you can't sign in, recover your account at ${recoverUrl}.`,
    "If it wasn't you, you can ignore this email.",
  ];
  await sendSystem({
    to,
    subject: 'Your Oxy account',
    text: paragraphs.join('\n\n'),
    html: htmlPage(paragraphs),
  });
}
