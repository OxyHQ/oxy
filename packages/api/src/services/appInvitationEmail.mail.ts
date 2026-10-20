/**
 * The one email an application may have Oxy send for it (`invitations:email`):
 * "{inviter} invited you to {resource} on {application}", and a single link.
 *
 * Pure: it renders, it does not send. Every value but the link is plain text
 * the caller does not control the markup of — the inviter's name and handle are
 * Oxy's, the application's name is staff-registered, and the resource name is
 * the caller's TEXT, escaped wherever it lands. The link was checked against
 * the application's registered origins before it was ever stored, and the
 * email says which host it opens, so a reader can see where it goes.
 *
 * Styled from the same Bloom-generated tokens as the welcome email
 * (`emailTheme.generated.json`), with no remote stylesheet, image or tracking.
 */
import type { AppInvitationEmailLocale } from '../db/schema/applicationInvitationEmails';
import theme from './emailTheme.generated.json';

export interface AppInvitationEmailContent {
  /** The inviter's display name, or their handle when they have none. */
  inviterName: string;
  /** The inviter's handle, shown beside the name so it can be recognised. */
  inviterHandle: string | null;
  resourceName: string;
  applicationName: string;
  acceptUrl: string;
  locale: AppInvitationEmailLocale;
}

interface Strings {
  subject: (v: Vars) => string;
  lead: (v: Vars) => string;
  body: string;
  action: string;
  fallback: string;
  destination: (host: string) => string;
  footer: (v: Vars) => string;
}

interface Vars {
  inviter: string;
  /** `Nate (@nate)`, or just the name when there is no handle. */
  inviterWithHandle: string;
  resource: string;
  application: string;
}

const STRINGS: Record<AppInvitationEmailLocale, Strings> = {
  en: {
    subject: (v) => `${v.inviter} invited you to ${v.resource} on ${v.application}`,
    lead: (v) => `${v.inviterWithHandle} invited you to join ${v.resource} on ${v.application}.`,
    body: 'Accept the invitation to get started. You can sign in with your Oxy account, or create one for free.',
    action: 'Accept invitation',
    fallback: 'Or copy this link into your browser:',
    destination: (host) => `This invitation opens ${host}.`,
    footer: (v) =>
      `You received this email because ${v.inviterWithHandle} invited this address on ${v.application}. If you were not expecting it, you can ignore it: nothing happens unless you open the link.`,
  },
  es: {
    subject: (v) => `${v.inviter} te ha invitado a ${v.resource} en ${v.application}`,
    lead: (v) =>
      `${v.inviterWithHandle} te ha invitado a unirte a ${v.resource} en ${v.application}.`,
    body: 'Acepta la invitación para empezar. Puedes iniciar sesión con tu cuenta de Oxy o crear una gratis.',
    action: 'Aceptar invitación',
    fallback: 'O copia este enlace en tu navegador:',
    destination: (host) => `Esta invitación abre ${host}.`,
    footer: (v) =>
      `Has recibido este correo porque ${v.inviterWithHandle} invitó a esta dirección en ${v.application}. Si no lo esperabas, puedes ignorarlo: no pasa nada a menos que abras el enlace.`,
  },
};

const light = theme.light;
const dark = theme.dark;
const font = 'Arial, Helvetica, sans-serif';

function typeStyle(role: keyof typeof theme.typography): string {
  const token = theme.typography[role];
  return `font-family:${font};font-size:${token.fontSize};line-height:${token.lineHeight};font-weight:${token.fontWeight};`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** Render the subject, the plain-text part and the HTML part. */
export function renderAppInvitationEmail(content: AppInvitationEmailContent): {
  subject: string;
  text: string;
  html: string;
} {
  const strings = STRINGS[content.locale];
  const vars: Vars = {
    inviter: content.inviterName,
    inviterWithHandle: content.inviterHandle
      ? `${content.inviterName} (@${content.inviterHandle})`
      : content.inviterName,
    resource: content.resourceName,
    application: content.applicationName,
  };
  const host = new URL(content.acceptUrl).host;
  const subject = strings.subject(vars);
  const lead = strings.lead(vars);
  const footer = strings.footer(vars);
  const destination = strings.destination(host);

  const text = [
    subject,
    lead,
    strings.body,
    `${strings.action}: ${content.acceptUrl}`,
    destination,
    footer,
  ].join('\n\n');

  const url = escapeHtml(content.acceptUrl);
  const html = `<!doctype html>
<html lang="${content.locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${escapeHtml(subject)}</title>
  <style>
    :root { color-scheme:light dark; supported-color-schemes:light dark; }
    @media only screen and (max-width:540px) {
      .oxy-padding { padding:28px 20px !important; }
      .oxy-outer { padding:20px 12px !important; }
    }
    @media (prefers-color-scheme:dark) {
      .oxy-body { background-color:${dark.background} !important; color:${dark.foreground} !important; }
      .oxy-card { background-color:${dark.card} !important; border-color:${dark.border} !important; color:${dark['card-foreground']} !important; }
      .oxy-heading { color:${dark['card-foreground']} !important; }
      .oxy-muted { color:${dark['muted-foreground']} !important; }
      .oxy-button { background-color:${dark.primary} !important; border-color:${dark.primary} !important; color:${dark['primary-foreground']} !important; }
    }
  </style>
</head>
<body class="oxy-body" bgcolor="${light.background}" style="margin:0;padding:0;background-color:${light.background};color:${light.foreground};${typeStyle('body')}-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(lead)}</div>
  <table class="oxy-body" role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${light.background}" style="background-color:${light.background};">
    <tr><td class="oxy-outer" align="center" style="padding:28px 16px;">
      <table role="presentation" width="100%" align="center" border="0" cellspacing="0" cellpadding="0" style="width:100%;max-width:520px;table-layout:fixed;">
        <tr><td class="oxy-card oxy-padding" align="center" bgcolor="${light.card}" style="padding:36px 32px;border:1px solid ${light.border};border-radius:${theme.radius.card};background-color:${light.card};color:${light['card-foreground']};">
          <h1 class="oxy-heading" style="${typeStyle('headerBold')}color:${light['card-foreground']};margin:0 0 20px;overflow-wrap:anywhere;word-break:break-word;">${escapeHtml(subject)}</h1>
          <p class="oxy-muted" style="${typeStyle('body')}color:${light['muted-foreground']};margin:0 0 16px;overflow-wrap:anywhere;">${escapeHtml(lead)}</p>
          <p class="oxy-muted" style="${typeStyle('body')}color:${light['muted-foreground']};margin:0 0 24px;">${escapeHtml(strings.body)}</p>
          <table role="presentation" align="center" border="0" cellspacing="0" cellpadding="0">
            <tr><td class="oxy-button" align="center" bgcolor="${light.primary}" style="background-color:${light.primary};border-radius:${theme.radius.button};mso-padding-alt:12px 24px;">
              <a class="oxy-button" href="${url}" target="_blank" rel="noopener noreferrer" style="${typeStyle('buttonLarge')}display:inline-block;padding:12px 24px;border:1px solid ${light.primary};border-radius:${theme.radius.button};background-color:${light.primary};color:${light['primary-foreground']};text-decoration:none;text-align:center;">${escapeHtml(strings.action)}</a>
            </td></tr>
          </table>
          <p class="oxy-muted" style="${typeStyle('bodySmall')}color:${light['muted-foreground']};margin:24px 0 0;overflow-wrap:anywhere;word-break:break-all;">${escapeHtml(strings.fallback)}<br><a href="${url}" target="_blank" rel="noopener noreferrer" style="color:${light.primary};">${url}</a></p>
          <p class="oxy-muted" style="${typeStyle('bodySmall')}color:${light['muted-foreground']};margin:12px 0 0;">${escapeHtml(destination)}</p>
        </td></tr>
        <tr><td align="center" style="padding:20px 20px 0;">
          <p class="oxy-muted" style="${typeStyle('bodySmall')}color:${light['muted-foreground']};margin:0;overflow-wrap:anywhere;">${escapeHtml(footer)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject, text, html };
}
