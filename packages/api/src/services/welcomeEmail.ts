import theme from './emailTheme.generated.json';

// Generated from Bloom. Literal values also work without a theme provider or
// remote stylesheet. Graphics use Oxy's own public assets: Inbox strips inline
// SVG and data URLs from untrusted mail, but supports these <img> resources.
const light = theme.light;
const dark = theme.dark;
const font = 'Arial, Helvetica, sans-serif';
export const WELCOME_EMAIL_MARKER = 'data-oxy-welcome-version="2"';
const typeStyle = (role: keyof typeof theme.typography): string => {
  const token = theme.typography[role];
  return `font-family:${font};font-size:${token.fontSize};line-height:${token.lineHeight};font-weight:${token.fontWeight};`;
};

const inboxTips = [
  [
    'Send your first hello',
    'Choose Compose in Inbox to write a message. Your new Oxy address is ready to share with friends, family and the people you work with.',
  ],
  [
    'Give everything a place',
    'Use labels to organise your mail and bundles to keep related conversations together. Archive finished conversations to keep your inbox clear.',
  ],
  [
    'Make room for what matters',
    'Pin a message to keep it close, or snooze it until you have time to come back. You can try either on this welcome email.',
  ],
] as const;
const apps = [
  {
    name: 'Mention',
    description:
      'Share what you are thinking, discover conversations and connect with people on an open social network.',
    image: 'mention.png',
    url: 'https://oxy.so/mention',
  },
  {
    name: 'Allo',
    description: 'Make space for everyday conversations with the people who matter to you.',
    image: 'allo.png',
    url: 'https://oxy.so/apps/allo',
  },
  {
    name: 'Alia',
    description: 'Meet your AI assistant for questions, ideas and help with everyday tasks.',
    image: 'alia.svg',
    url: 'https://oxy.so/ai',
  },
] as const;
const sections = {
  inbox: {
    title: 'You are already home in Inbox',
    description:
      'You are reading your first Oxy email right here in Inbox. Here are three things to try when you are ready.',
  },
  profile: {
    title: 'Make your account feel like you',
    description:
      'Add a profile photo, choose your display name and check your personal information. Your Oxy account is the account you use across Oxy apps, so you can bring a familiar profile with you.',
    action: 'Personalise your account',
    url: 'https://accounts.oxy.so/personal-info',
  },
  apps: {
    title: 'One account. More to discover.',
    description:
      'Inbox is just the beginning. Explore more from Oxy and choose Continue with Oxy when you sign in. You can use the account you already created.',
    action: 'Explore Oxy apps',
    url: 'https://oxy.so/apps',
  },
  security: {
    title: 'A good time for a security check',
    description:
      'Take a moment to review how you sign in. You can manage your password and authenticator, check signed-in devices and review connected apps from your account settings.',
    action: 'Review your security',
    url: 'https://accounts.oxy.so/security',
  },
  privacy: {
    title: 'Your account, your choices',
    description:
      'Choose the privacy and sharing settings that work for you. Review your data preferences, decide what activity you share and download a copy of your account data whenever you need it.',
    action: 'Review privacy and data',
    url: 'https://accounts.oxy.so/data',
  },
  help: {
    title: 'A little help, whenever you need it',
    description:
      'From getting started to managing your account, the Oxy Help Center is here when you have a question. Keep this email handy, or pin it in Inbox so these shortcuts are easy to find.',
    action: 'Visit the Help Center',
    url: 'https://oxy.so/help',
  },
} as const;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}
function image(src: string, alt: string, size: number, backdrop = false): string {
  return `<img src="${src}" alt="${alt}" width="${size}" height="${size}" style="display:block;width:${size}px;height:${size}px;max-width:100%;border:0;${backdrop ? `background-color:${light.card};border-radius:${theme.radius.card};` : ''}" />`;
}
function paragraph(content: string): string {
  return `<p class="oxy-muted" style="${typeStyle('body')}color:${light['muted-foreground']};margin:0 0 24px;">${content}</p>`;
}
function heading(title: string): string {
  return `<h2 class="oxy-heading" style="${typeStyle('sectionTitle')}color:${light['card-foreground']};margin:0 0 16px;">${title}</h2>`;
}
function eyebrow(label: string): string {
  return `<p class="oxy-brand" style="${typeStyle('bodySmall')}color:${light.primary};font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 16px;">${label}</p>`;
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
  </td></tr><tr><td height="20" aria-hidden="true" style="height:20px;font-size:0;line-height:0;">&nbsp;</td></tr>`;
}
function actionCard(
  label: string,
  section:
    | typeof sections.profile
    | typeof sections.security
    | typeof sections.privacy
    | typeof sections.help,
): string {
  return card(
    `${eyebrow(label)}${heading(section.title)}${paragraph(section.description)}${button(section.action, section.url)}`,
  );
}

/** Pure renderer: only Oxy graphics/links, no tracking or delivery side effects. */
export function renderWelcomeEmail(displayName: string, recipientAddress: string) {
  const subject = 'Welcome to Oxy';
  const greeting = `Hi ${displayName.trim() || 'there'},`;
  const introduction =
    'Welcome to Oxy. Your new account opens the door to apps for connecting, creating and getting things done. We are glad you are here.';
  const footer = 'You received this welcome email because your Oxy Inbox was created.';
  const actionText = (
    section:
      | typeof sections.profile
      | typeof sections.apps
      | typeof sections.security
      | typeof sections.privacy
      | typeof sections.help,
  ) => [section.title, section.description, `${section.action}: ${section.url}`].join('\n');
  const text = [
    greeting,
    introduction,
    `Your email address: ${recipientAddress}`,
    'Here is a little guide to help you settle in.',
    sections.inbox.title,
    sections.inbox.description,
    ...inboxTips.map(([title, description], i) => `${i + 1}. ${title}\n${description}`),
    actionText(sections.profile),
    sections.apps.title,
    sections.apps.description,
    ...apps.map(
      ({ name, description, url }) => `${name}\n${description}\nDiscover ${name}: ${url}`,
    ),
    `${sections.apps.action}: ${sections.apps.url}`,
    actionText(sections.security),
    actionText(sections.privacy),
    actionText(sections.help),
    'Thanks for making Oxy part of your day.',
    'The Oxy Team',
    'https://oxy.so',
    footer,
  ].join('\n\n');
  const logo = image('https://oxy.so/logo-mark.svg', 'Oxy', 64);
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
      .oxy-inset { background-color:${dark.background} !important; border-color:${dark.border} !important; }
      .oxy-button { background-color:${dark.primary} !important; border-color:${dark.primary} !important; color:${dark['primary-foreground']} !important; }
    }
  </style>
</head>
<body class="oxy-body" bgcolor="${light.background}" style="margin:0;padding:0;background-color:${light.background};color:${light.foreground};${typeStyle('body')}-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Welcome to Oxy. Get comfortable in Inbox, discover your apps and make your account yours.</div>
  <table ${WELCOME_EMAIL_MARKER} class="oxy-body" role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${light.background}" style="background-color:${light.background};">
    <tr><td class="oxy-outer" align="center" style="padding:28px 16px;">
      <!--[if mso]><table role="presentation" width="520" align="center" border="0" cellspacing="0" cellpadding="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" align="center" border="0" cellspacing="0" cellpadding="0" style="width:100%;max-width:520px;table-layout:fixed;">
        <tr><td align="center" style="padding:0 0 24px;"><a href="https://oxy.so" target="_blank" rel="noopener noreferrer" style="display:inline-block;">${logo}</a></td></tr>
        ${card(`${eyebrow('Welcome to Oxy')}
          <h1 class="oxy-heading" style="${typeStyle('headerBold')}color:${light['card-foreground']};margin:0 0 20px;overflow-wrap:anywhere;word-break:break-word;">${escapeHtml(greeting)}</h1>
          ${paragraph(introduction)}
          <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"><tr><td class="oxy-inset oxy-heading" align="center" style="padding:20px 12px;background-color:${light.background};border:1px solid ${light.border};border-radius:${theme.radius.card};color:${light['card-foreground']};${typeStyle('body')}">Your email address<br><strong style="overflow-wrap:anywhere;word-break:break-all;">${escapeHtml(recipientAddress)}</strong></td></tr></table>
          <p class="oxy-muted" style="${typeStyle('body')}color:${light['muted-foreground']};margin:24px 0 0;">Here is a little guide to help you settle in.</p>`)}
        ${card(`${eyebrow('Start right here')}${heading(sections.inbox.title)}${paragraph(sections.inbox.description)}
          <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">${inboxTips.map(([title, description], i) => `<tr><td valign="top" width="32" class="oxy-brand" style="padding:0 12px 20px 0;color:${light.primary};${typeStyle('sectionTitle')}">${i + 1}.</td><td align="left" style="padding:0 0 20px;"><h3 class="oxy-heading" style="${typeStyle('body')}font-weight:700;color:${light['card-foreground']};margin:0 0 6px;">${title}</h3><p class="oxy-muted" style="${typeStyle('body')}color:${light['muted-foreground']};margin:0;">${description}</p></td></tr>`).join('')}</table>`)}
        ${actionCard('A familiar face', sections.profile)}
        ${card(`${eyebrow('More from Oxy')}${heading(sections.apps.title)}${paragraph(sections.apps.description)}
          <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">${apps.map(({ name, description, image: asset, url }) => `<tr><td valign="top" width="64" style="padding:4px 16px 24px 0;">${image(`https://oxy.so/images/apps/${asset}`, '', 48, true)}</td><td align="left" style="padding:0 0 24px;"><h3 style="${typeStyle('body')}font-weight:700;margin:0 0 6px;"><a class="oxy-brand" href="${url}" target="_blank" rel="noopener noreferrer" style="color:${light.primary};text-decoration:underline;">${name}</a></h3><p class="oxy-muted" style="${typeStyle('body')}color:${light['muted-foreground']};margin:0;">${description}</p></td></tr>`).join('')}</table>
          ${button(sections.apps.action, sections.apps.url)}`)}
        ${actionCard('Peace of mind', sections.security)}
        ${actionCard('You decide', sections.privacy)}
        ${actionCard('We are here to help', sections.help)}
        <tr><td align="center" style="padding:8px 20px 20px;">
          ${paragraph('Thanks for making Oxy part of your day.<br>The Oxy Team')}
          <table role="presentation" align="center" border="0" cellspacing="0" cellpadding="0"><tr><td style="padding:0 0 20px;">${image('https://oxy.so/logo-mark.svg', 'Oxy', 40)}</td></tr></table>
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
