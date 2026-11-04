# ADR 0055 — One translation key convention for every Oxy app and service

- Status: accepted
- Date: 2026-11-04
- Scope: every translation catalog in the ecosystem (product apps, consoles,
  dashboards, the SDK's own dictionaries and the IdP's pages)
- Builds on: [0022](0022-app-i18n-follows-oxy-language.md). That ADR decides
  *which* language and leaves the library to each app. This one decides how a
  catalog is keyed. Nothing here changes a library.

## Context

The catalogs were audited at `origin/main` of every repository on 2026-11-04.
Most were already keyed one way: nested objects of short identifier segments,
`common.loading`, `artist.inPlaylists`, `donations.page.frequency.label` (Alia,
Clarity, CrowdSource, Homiio, Mercaria, Moovo, Move, Noted, Nilo, Syra, tnp,
Willo, accounts, commons, and the SDK's and IdP's TypeScript dictionaries).

Three were not, and no document said which way was right:

- **Mention** keyed 1,838 of its 3,018 strings by flat top-level strings. Some
  of those were the English text itself (`"Nobody": "Niemand"`,
  `"Your post could not be published. {{detail}}"`). Most were dotted paths
  stored as one flat string (`"plus.checkout.soundOn"`). The English sentence as
  a key changes whenever the copy changes. One sentence used in two places
  cannot be given two translations. Nothing shows where a string belongs, so a
  dead string is invisible: the translations held 11,000 keys the English
  catalog no longer had.
- **Schedio** had the same mix, 372 flat entries.
- **Allo** stored every key as a flat dotted string (`"chat.sticker.unavailable"`).
  The keys were well chosen but read with `keySeparator: false`. That is a second
  dialect: the same path means a different JSON shape in Allo than in every
  other app.

## Decision

1. **A key is a path of identifier segments, stored as nested objects.**
   `compose.toolbar.addImage` is
   `{ "compose": { "toolbar": { "addImage": "Add image" } } }`. It is never one
   flat `"compose.toolbar.addImage"` string, and the English text is never the
   key. i18next's default `keySeparator` (`.`) reads it. No app sets
   `keySeparator: false`.
2. **Segments.** Authored segments are lowerCamelCase: `feature.surface.element`,
   for example `explore.newPeople.empty` or `settings.privacy.blockedTitle`. A
   segment that mirrors a data value keeps that value verbatim, so a lookup
   needs no mapping table: `status.picked_up`, `region.us-east-1`,
   `currency.EUR`. Plural forms keep i18next's suffixes
   (`count_one` / `count_other`); an i18n-js catalog nests them instead
   (`count.one` / `count.other`). Either way a translation carries the
   categories its own language selects (`few`, `many`) even when English has
   no such form. A segment never contains spaces, punctuation
   or a dot.
3. **The first segment is a namespace.** In a single-file catalog
   (`locales/en.json`) every top-level entry is a namespace object. A
   per-namespace catalog (`locales/en/compose.json`) is that namespace's file.
   Both layouts are valid. An app chooses per-namespace when it lazy-loads
   namespaces.
4. **One key per meaning, deduplicated within the app.** Text shared across
   screens lives under `common` (`common.cancel`, `common.save`,
   `common.retry`). The same English word with two meanings gets two keys,
   because other languages translate them differently. A key nothing reads is
   deleted, from every locale.
5. **English (`en`) is the source.** A translation holds only keys the source
   has, with the same shape and the same `{{placeholders}}`. A missing
   translation falls back to English. That is a translation backlog, not a
   defect.
6. **Enforced by `oxy-doctor-i18n`** (`@oxy.so/doctor` ≥ 1.6.0), which every app
   runs in CI as `bunx oxy-doctor-i18n --ci`. It finds every `locales`
   directory with an `en` catalog. These fail it: a text key, a flat dotted
   key, a top-level string, a non-string leaf, a key in a translation the
   source lacks, a shape mismatch. It warns on a missing translation or a
   placeholder mismatch. TypeScript dictionaries (the SDK's `LocaleDict`, the
   IdP's) already follow the convention and are held to it by their types.

## Consequences

- Mention, Schedio and Allo migrate: keys rewritten across code and every
  locale, dead keys deleted, `keySeparator: false` removed. Every other
  catalog already passes or needs only small fixes (one top-level string,
  stray translations).
- Moving copy now means moving a key. That is the point: the key records where
  the copy belongs.
- The doctor check reads catalogs only. Unused-key detection stays with each
  app's own validator, because only the app knows its dynamic keys
  (`t(option.labelKey)`).
