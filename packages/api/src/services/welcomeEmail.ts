import theme from './emailTheme.generated.json';

// Generated from Bloom by bun scripts/generate-email-theme.mjs. Email clients
// need literal CSS values, not a provider, CSS variables or remote stylesheets.
const light = theme.light;
const dark = theme.dark;
const font = 'Arial, Helvetica, sans-serif';
const typeStyle = (role: keyof typeof theme.typography): string => {
  const token = theme.typography[role];
  return `font-family:${font};font-size:${token.fontSize};line-height:${token.lineHeight};font-weight:${token.fontWeight};`;
};

const sections = [
  {
    title: 'Your inbox, ready for you',
    description:
      'Keep your mail organised with labels and bundles. Snooze messages for later and pin the ones that matter.',
    action: 'Open Inbox',
    url: 'https://inbox.oxy.so',
  },
  {
    title: 'One account, more from Oxy',
    description:
      'Discover Oxy apps and services, and use your Oxy account to make yourself at home.',
    action: 'Explore Oxy',
    url: 'https://oxy.so',
  },
  {
    title: 'Make your account yours',
    description:
      'Review your personal information, privacy and security settings in your Oxy account.',
    action: 'Manage your account',
    url: 'https://accounts.oxy.so',
  },
  {
    title: 'Find answers',
    description: 'Visit the Oxy Help Center to learn more about your account and get started.',
    action: 'Visit the Help Center',
    url: 'https://oxy.so/help',
  },
] as const;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function button(label: string, url: string): string {
  return `<table role="presentation" align="center" border="0" cellspacing="0" cellpadding="0">
    <tr><td class="oxy-button" align="center" bgcolor="${light.primary}" style="background-color:${light.primary};border-radius:${theme.radius.button};mso-padding-alt:12px 24px;">
      <a class="oxy-button" href="${url}" target="_blank" rel="noopener noreferrer" style="${typeStyle('buttonLarge')}display:inline-block;padding:12px 24px;border:1px solid ${light.primary};border-radius:${theme.radius.button};background-color:${light.primary};color:${light['primary-foreground']};text-decoration:none;text-align:center;">${label}</a>
    </td></tr>
  </table>`;
}

function card(content: string): string {
  return `<tr><td class="oxy-card oxy-padding" align="center" bgcolor="${light.card}" style="padding:36px 32px;border:1px solid ${light.border};border-radius:${theme.radius.card};background-color:${light.card};color:${light['card-foreground']};">
    ${content}
  </td></tr>
  <tr><td height="20" aria-hidden="true" style="height:20px;font-size:0;line-height:0;">&nbsp;</td></tr>`;
}

/** Pure renderer: no network resources, tracking, or changes to mailbox delivery. */
export function renderWelcomeEmail(displayName: string, recipientAddress: string) {
  const subject = 'Welcome to Oxy';
  const greeting = `Hi ${displayName.trim() || 'there'},`;
  const introduction =
    'Welcome to Oxy. Your new account gives you access to Oxy apps and services. Here are a few ways to get started.';
  const footer = 'You received this email because your Oxy Inbox was created.';
  const text = [
    greeting,
    introduction,
    `Your email address: ${recipientAddress}`,
    ...sections.map(({ title, description, action, url }) =>
      [title, description, `${action}: ${url}`].join('\n'),
    ),
    'The Oxy Team',
    footer,
  ].join('\n\n');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${subject}</title>
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
      .oxy-brand { color:${dark.primary} !important; }
      .oxy-button { background-color:${dark.primary} !important; border-color:${dark.primary} !important; color:${dark['primary-foreground']} !important; }
    }
  </style>
</head>
<body class="oxy-body" bgcolor="${light.background}" style="margin:0;padding:0;background-color:${light.background};color:${light.foreground};${typeStyle('body')}-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Your Oxy account is ready. Discover your inbox, apps and account settings.</div>
  <table class="oxy-body" role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${light.background}" style="background-color:${light.background};">
    <tr><td class="oxy-outer" align="center" style="padding:28px 16px;">
      <!--[if mso]><table role="presentation" width="520" align="center" border="0" cellspacing="0" cellpadding="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" align="center" border="0" cellspacing="0" cellpadding="0" style="width:100%;max-width:520px;table-layout:fixed;">
        <tr><td align="center" style="padding:0 0 24px;">
          <a class="oxy-brand" href="https://oxy.so" style="${typeStyle('headerBold')}color:${light.primary};text-decoration:none;">Oxy</a>
        </td></tr>
        ${card(`<h1 class="oxy-heading" style="${typeStyle('headerBold')}color:${light['card-foreground']};margin:0 0 20px;overflow-wrap:anywhere;word-break:break-word;">${escapeHtml(greeting)}</h1>
          <p class="oxy-muted" style="${typeStyle('body')}color:${light['muted-foreground']};margin:0 0 20px;">${introduction}</p>
          <p class="oxy-heading" style="${typeStyle('body')}color:${light['card-foreground']};margin:0;">Your email address<br><strong style="overflow-wrap:anywhere;word-break:break-all;">${escapeHtml(recipientAddress)}</strong></p>`)}
        ${sections
          .map(({ title, description, action, url }) =>
            card(`<h2 class="oxy-heading" style="${typeStyle('sectionTitle')}color:${light['card-foreground']};margin:0 0 16px;">${title}</h2>
          <p class="oxy-muted" style="${typeStyle('body')}color:${light['muted-foreground']};margin:0 0 24px;">${description}</p>
          ${button(action, url)}`),
          )
          .join('\n')}
        <tr><td align="center" style="padding:8px 20px 20px;">
          <p class="oxy-brand" style="${typeStyle('sectionTitle')}color:${light.primary};margin:0 0 12px;">Oxy</p>
          <p class="oxy-muted" style="${typeStyle('bodySmall')}color:${light['muted-foreground']};margin:0;">${footer}</p>
        </td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}
