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

Application **General** edits identity, legal links and OAuth redirect URIs. It never
writes `application.scopes`. **Credentials** separates registered Oxy workload
identity from external API products and credentials ([ADR 0049](../../docs/adr/0049-first-party-platform-authority.md)).
Workload bindings remain deployment-operator configuration; this screen does not
read binding status or create/rotate workload secrets. The standard recipient
audience is `oxy-service:<applicationId>`; product protocols such as Kaana retain
their documented audience.

API product switches edit the external credential ceiling, including for an
Oxy-owned registration. Every `service` and `machine` credential selects a nonempty
subset explicitly; its authority remains external. Third-party service clients
can select payments/application-file scopes allowed by the API. Public and
confidential OAuth client registrations keep their existing login/consent flow.
Account roles, billing, credential rotation/revocation and secret-once display are
unchanged. Untouched external scopes, including partial Alia grants, are preserved.

`components/apps/__tests__/credential-authority.test.tsx` exercises own and external
registration flows, save payloads, account-role controls and stale scope selection.
