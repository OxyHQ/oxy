# Entry campaign attribution

`OxyProvider campaignAttribution` opts an app into device-local first-touch
capture. The shared SDK reads the initial browser/native link and later native
link events. It persists the first valid campaign, never replacing it on a later
visit. The capture is ready before a configured language bridge exposes signup.

```tsx
<OxyProvider
  campaignAttribution
  language={{
    supportedLocales: ['en-US', 'es-ES'],
    fallbackLocale: 'en-US',
    legacyStorageKeys: ['old_app_language_key'],
    onChange: loadAppTranslations,
  }}
>
  <App />
</OxyProvider>
```

Only `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term` and
`fbclid` are read. Repeated, empty, control-character or overlong values are
ignored. Labels are bounded to 256 UTF-16 units and click IDs to 1024. URLs,
referrers and IP addresses are not stored. This is self-declared acquisition
metadata, never an authorization, identity or payment signal.

The built-in signup panel sends `languages` and optional `campaignAttribution`
through `oxy.auth.signUp`. Custom signup UIs can use the same typed fields.
The API validates the payload, inserts one private `account_acquisition` row
inside the account-creation transaction, and removes it when that account is
deleted. It has no public profile projection or mutation endpoint. Migration
`0221_account_acquisition.sql` is additive and precedes the API rollout; deploy
that API before enabling a newly published SDK in consumer apps.

Operators can read bounded daily attributed-signup totals using existing private
API database access (no new HTTP/admin permission surface):

```bash
bun packages/api/scripts/report-account-acquisition.ts 2026-10-01 2026-11-01
```

The interval is UTC and end-exclusive, at most 366 days. Output groups by day,
source, medium and campaign, without account IDs or click IDs. The date-leading
index bounds the scan. Counts reflect retained attributed accounts; organic
registrations with no campaign are absent and erased accounts are excluded.

This does **not** configure Meta Ads installation reporting, infer attribution
across an app-store install, collect advertising identifiers or initialize a
third-party tracking SDK. Native installation attribution requires the app's
actual Meta registration/App ID/client token (or an explicitly chosen MMP),
platform linking and the applicable tracking permission/consent flow. It must be
validated separately against that provider's dashboard; internal signup totals
are not evidence that an ad platform has received install events.
