const config = {
  oxyUrl: import.meta.env.VITE_OXY_URL || 'https://api.oxy.so',
  accountsUrl: import.meta.env.VITE_ACCOUNTS_URL || 'https://accounts.oxy.so',
  docsUrl: import.meta.env.VITE_DOCS_URL || 'https://oxy.so/developers/docs',
  clarityUrl: import.meta.env.VITE_CLARITY_URL || 'https://api.clarity.surf',
  // Public OAuth client id for this app (the registered `ApplicationCredential`
  // publicKey). Drives the #214 app-identity flow when passed to
  // `OxyProvider`. Public value — safe to commit. Overridable per
  // environment via `VITE_OXY_CLIENT_ID`.
  clientId:
    import.meta.env.VITE_OXY_CLIENT_ID ||
    'oxy_dk_2bdf04f596037ac720f94a54df405b974f240e5392a2e668',
  authRedirectUri:
    import.meta.env.VITE_OXY_AUTH_REDIRECT_URI || 'https://console.oxy.so',
};

export default config;
