# Oxy Console

console.oxy.so: where apps, API keys (Alia, Kaana, Mention), billing and inference routing are managed.

Expo Router + Bloom, web only (`expo export --platform web`, `output: 'single'`), served by the
`oxy-console` Worker (`wrangler.toml`). Layout follows Inbox: Bloom `AppShell` with sidebar,
bottom bar and panels (`components/shell/`). Routes are in `app/(shell)/`; add a sidebar section in
`lib/navigation.ts`.

```bash
bun run dev      # expo start --web, port 8106
bun run test     # jest (never bare `bun test`)
bun run build    # export + _headers
```

Client id: `EXPO_PUBLIC_OXY_CLIENT_ID` (default in `lib/config.ts`).
