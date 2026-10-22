// Public values, safe to commit. Metro inlines `process.env.EXPO_PUBLIC_*` only
// as a literal member access — never destructure or index it.
const websiteUrl = process.env.EXPO_PUBLIC_WEBSITE_URL || 'https://oxy.so';

const config = {
  websiteUrl,
  // The legal pages the first-run welcome links to (they open on the Oxy website).
  legalUrls: {
    terms: `${websiteUrl}/transparency/legal/terms`,
    aup: `${websiteUrl}/transparency/legal/aup`,
    privacy: `${websiteUrl}/transparency/legal/privacy`,
    dataUse: `${websiteUrl}/transparency/legal/llms`,
  },
  oxyUrl: process.env.EXPO_PUBLIC_OXY_URL || 'https://api.oxy.so',
  accountsUrl: process.env.EXPO_PUBLIC_ACCOUNTS_URL || 'https://accounts.oxy.so',
  docsUrl: process.env.EXPO_PUBLIC_DOCS_URL || 'https://oxy.so/developers/docs',
  clarityUrl: process.env.EXPO_PUBLIC_CLARITY_URL || 'https://api.clarity.surf',
  // The registered `ApplicationCredential` publicKey for this app.
  clientId:
    process.env.EXPO_PUBLIC_OXY_CLIENT_ID ||
    'oxy_dk_2bdf04f596037ac720f94a54df405b974f240e5392a2e668',
  authRedirectUri: process.env.EXPO_PUBLIC_OXY_AUTH_REDIRECT_URI || 'https://console.oxy.so',
};

export default config;
