# 0022 — Oxy resolves the language; every app keeps its own translations

- Status: accepted
- Scope: `@oxy.so/services`' `OxyProvider`, `@oxy.so/core`'s language utilities,
  and the i18n setup of every consuming app
- Asked by: Mention (multilingual posts and an AI-translate action surfaced a
  real bug — the app's displayed language had no relationship to the account's
  declared language at all)

## Context

`useOxy().currentLanguage` already resolves ONE language per viewer — the
account's primary locale (`user.languages[0]`) when signed in, otherwise a
locally-chosen guest override, otherwise the device locale — and
`LanguageSelectorScreen` already lets a viewer pick and reorder their account's
locales, signed in or not. This is the single, already-correct authority for
*which* language a person wants.

Every product app was blind to it. Mention's `lib/i18n.ts` read a language
choice from its own local storage key, defaulting to a hardcoded `en-US`, with
no code path that ever consulted the account at all — a bilingual reader whose
account listed `[en, es]` still saw Mention's chrome in whatever the device
happened to boot in. Allo independently built the identical pattern (own
storage key, own hardcoded default). Homiio built a third, its own
`languagePreference.ts`. Three apps, three private, mutually inconsistent
re-derivations of a question Oxy already answers.

This was not a Mention bug to patch in Mention. Every current and future Oxy
app faces the identical problem, and a fourth from-scratch reimplementation
would be the same defect again under a different file name.

### Two library families already coexist, on purpose

`@oxy.so/services`' own embedded surfaces (`ManageAccountScreen`,
`LanguageSelectorScreen`, and every other `showBottomSheet`-opened screen) use
a dependency-free translator: `useI18n()` derives `t()` from
`useOxy().currentLanguage` via `useMemo`, calling `@oxy.so/core`'s
`translate(locale, key, vars)` — a flat dictionary lookup with `{{var}}`
interpolation, no external library, no imperative "change language" call
anywhere. This is deliberate: these screens are *embedded inside a host app the
SDK does not control*, so they must not force a translation library, or its
weight, onto every consumer. Mention, Alia, Homiio and every other host stay
free to use whatever they already use for their own, much larger, vocabularies.

Mention, Allo and Homiio all separately chose `react-i18next` for their own app
text, and correctly so for a full-size product catalog: it has CLDR
pluralization (Mention: 16 call sites over 25 key pairs; Homiio: 43 call sites
over 27 pairs — a real, load-bearing feature, not incidental usage),
established key-extraction and translation-management tooling, and per-locale
lazy loading these apps already rely on for bundle size. `@oxy.so/core`'s tiny
`translate()` has none of the first two and, being a closed map of ~11
eagerly-imported dictionaries sized for the SDK's own settings screens, cannot
absorb a full app catalog without regressing the third. Migrating product apps
onto it would trade a real, working system for a smaller one — reinventing
i18next, worse, maintained by one team instead of an OSS project. Considered
and rejected.

## Decision

**Oxy decides *which* language. Each app keeps its own translation library and
catalog, exactly as today, and is TOLD the resolved language through one prop
on `OxyProvider` it already mounts — no per-app effect, hook, or "sync"
component to write or remember to place correctly.**

```tsx
<OxyProvider
  oxyServices={oxyServices}
  language={{
    supportedLocales: SUPPORTED_LANGUAGES,  // this app's own shipped catalog
    fallbackLocale: DEFAULT_LANGUAGE,
    onChange: (locale) => i18n.changeLanguage(locale),  // this app's own library
  }}
>
```

`OxyProvider` derives the account/guest/device locale exactly as
`useOxy().currentLanguage` already does, coerces it to the closest locale the
CALLER'S OWN `supportedLocales` list actually has
(`@oxy.so/core`'s new `coerceToSupportedLocale`: exact match, then same base
language, then `fallbackLocale`), and calls `onChange` whenever that resolved
value changes. `language` is optional and costs nothing when omitted — an app
with no i18n of its own, or one that manages it independently, is unaffected.

### Why a provider prop, not a hook

A hook is one more thing to import and mount at exactly the right point in the
tree — inside `OxyProvider`, above wherever the app's own `I18nextProvider`
equivalent lives — and nothing stops it being mounted twice, forgotten, or
placed wrong. `OxyProvider` is mandatory and singular already. Passing the
bridge as its config, rather than as a second concept an app assembles itself,
is the one that cannot be gotten wrong or duplicated per app.

### The ecosystem standard this establishes

- **New apps default to `react-i18next`** for their own UI text — proven at
  product scale in three apps already, with tooling (key extraction,
  translation-management-platform import/export) no in-house dictionary format
  gets for free. An app is free to choose otherwise; `onChange` accepts any
  library's language-switch function, not only i18next's.
- **`@oxy.so/services`' own embedded screens keep `useI18n()`/`translate()`** —
  a deliberately separate, smaller answer to a deliberately smaller problem
  (a fixed, modest vocabulary shipped WITH the SDK to every host, regardless of
  what that host uses for its own text), not an inconsistency to unify away.
- **No app derives a language from anywhere but `OxyProvider`'s `language`
  prop.** A device locale, a browser header, or a locally-stored guess are
  already folded into `useOxy().currentLanguage`'s own resolution (see
  `useLanguageManagement`); an app reimplementing any part of that ladder
  itself is the exact defect this ADR retires.

## Consequences

- `@oxy.so/core` gains one pure export, `coerceToSupportedLocale(locale,
  supportedLocales, fallback)` — the algorithm every app (Mention's own
  `lib/i18n.ts`, and separately `packages/accounts`/`auth`/`commons`/`console`'s
  respective `coerceLocale`) had already reinvented against its own catalog.
- `@oxy.so/services` gains `OxyProvider`'s `language` prop, implemented by an
  internal `LanguageBridge` mounted inside `OxyRuntimeProvider` only when
  supplied.
- Product apps do not migrate their translation library or catalogs. Mention,
  Allo and Homiio each replace their own account-blind local-storage-driven
  language bootstrap with this one prop; their locale JSON files, `t()` call
  sites and pluralization are untouched.
- A viewer who reorders or adds a language in `LanguageSelectorScreen` — signed
  in or not — now sees every Oxy app they use follow it, because every app
  reads the same resolved value instead of keeping a private guess.

## Related

- `packages/core/src/utils/languageUtils.ts` — `coerceToSupportedLocale`,
  alongside `getUserLanguages`/`getPrimaryLanguage`
- `packages/services/src/ui/components/LanguageBridge.tsx` — the prop's
  implementation
- `packages/services/src/ui/hooks/useI18n.ts`,
  `packages/core/src/i18n/index.ts` — the SDK's own separate, smaller
  translator, unaffected by this decision
- ADR 0004 (single Oxy runtime provider) — locale metadata already lives "off
  the central value, as ordinary exports from `@oxy.so/services`"; this ADR is
  that intent's other half, host-app-facing rather than SDK-internal
- Mention's own migration: `packages/frontend/components/providers/AppProviders.tsx`
