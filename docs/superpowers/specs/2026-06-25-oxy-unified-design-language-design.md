# Oxy Unified Design Language — Design Spec

Date: 2026-06-25
Status: Draft for review
Owner: Nate (with Claude)
Scope: `@oxyhq/bloom`, `@oxyhq/services` (`packages/services`), `packages/auth` (auth.oxy.so IdP web app), and — by inheritance — every Oxy RP app.

## 1. Goal

Make every Oxy interface look like one product. A single, centralized design language **owned by Bloom**, consumed identically by oxy-auth, oxy-services, and the rest of the ecosystem. No per-app styling forks, no ad-hoc `StyleSheet`/inline styles in screens, no foreign token systems copied class-for-class.

Concretely:
- Bloom exposes a **complete semantic token vocabulary** as utility classes (NativeWind on native, Tailwind on web).
- Every screen/component is styled with those **utility classes** (`className`) + Bloom components — not `StyleSheet.create`, not inline `style={{…}}` where a class exists.
- Generic UI lives in **Bloom**; Oxy-product-specific composites live in **oxy-services** (or the relevant app), built on Bloom.

## 2. Principles

1. **Centralized in Bloom.** Tokens (color roles, spacing, radius, typography, shadow) are defined once in Bloom and surfaced as classes. Apps never redefine them.
2. **Class-based styling.** NativeWind/Tailwind `className` is the styling mechanism. `StyleSheet.create` and inline `style` are removed from consumer screens except where no class can express the rule (rare: dynamic measured values, animated transforms driven by Reanimated/Animated).
3. **Layering.** Bloom = generic primitives reusable by any app. oxy-services = Oxy-specific composites that consume Bloom. Placement test: *would another, non-Oxy app want this unchanged?* Yes → Bloom. No → services.
4. **Translate, never copy.** Reference snippets from other design systems (the "Shop"-style `bg-bg-fill` / `space-8` / `font-caption`) are translated into Bloom's vocabulary, mapped onto Bloom's single source of resolved theme values. We do not import a foreign token file.
5. **Single source of truth for values.** New semantic class names alias Bloom's existing resolved theme (`getResolvedTokens` / `ThemeColors`) wherever possible, so light/dark and brand presets stay driven by one resolver.
6. **Additive, non-breaking foundation.** The new vocabulary is added alongside Bloom's current classes; existing classes keep working during rollout so nothing breaks mid-migration.

## 3. Token Vocabulary (W0a)

Naming follows the reference style (namespaced semantic roles), exposed as Tailwind/NativeWind theme extensions in Bloom's preset and consumed as utilities.

### 3.1 Color roles
Surfaces, text, and borders are namespaced so a fill named `fill` used as a background reads `bg-fill`, a text color `text-tertiary` reads `text-text-tertiary`, etc. Each new role **aliases an existing Bloom `ThemeColors` value** (single source):

| Class token | Used as | Bloom source (ThemeColors) |
|---|---|---|
| `bg` | page background | `background` |
| `bg-fill` | card/surface | `card` |
| `bg-fill-secondary` | subtle fill | `backgroundSecondary` / `muted` |
| `bg-fill-hover` | hover surface | derived hover of `card` |
| `bg-fill-brand` / `-hover` | primary CTA | `primary` / hover |
| `bg-fill-inverse` / `-hover` | inverse CTA | `foreground`/inverse |
| `bg-fill-placeholder` | disabled fill | `muted`/disabled |
| `text` (→ `text-text`) | primary text | `text`/`foreground` |
| `text-secondary` | secondary text | `textSecondary` |
| `text-tertiary` | captions/hints | `mutedForeground`/`textTertiary` |
| `text-inverse` / `text-fixed-light` | on-inverse / on-brand | `primaryForeground` / fixed light |
| `text-placeholder` | placeholder | `mutedForeground` |
| `border` | default border | `border` |
| `border-image` | hairline (0.5px) | `border` at hairline width |
| `border-secondary` | inner divider | `border`/subtle |
| `border-input` / `-input-active` | input border / focus ring | `border` / `primary` |

(Exact mapping finalized during W0a against `getResolvedTokens`; the table is the contract, the values come from Bloom's resolver.)

### 3.2 Spacing scale
Named spacing tokens consumed as `p-space-8`, `gap-space-20`, `px-space-8`, etc. Values in px: `space-2: 2, space-4: 4, space-8: 8, space-12: 12, space-16: 16, space-20: 20, space-24: 24, space-32: 32` (extend as references demand). Also `px-screen-margin` for the standard horizontal page gutter.

### 3.3 Radius scale
`rounded-radius-8: 8, radius-12: 12, radius-20: 20, radius-28: 28, radius-max: 9999`.

### 3.4 Typography scale
Each role pairs a family/weight (`font-*`) with a size/line-height (`text-*`), driven by Bloom fonts (`--bloom-font-*`): `caption`, `bodySmall`, `bodyTitleSmall`, `body`, `subtitle`, `sectionTitle`, `headerBold`, `buttonLarge`. Sizes/line-heights finalized in W0a from a single type-scale table.

### 3.5 Shadow scale
`shadow-s`, `shadow-m` (and `-l` if needed). Cross-platform note: web uses `box-shadow`; native maps to elevation/shadow props. Bloom owns the platform split so consumers write one class.

### 3.6 Coexistence & migration
- New vocabulary is **additive**. Bloom's current shadcn-style classes (`bg-background`, `text-muted-foreground`, `rounded-lg`) and NativeWind aliases keep resolving.
- A documented **alias map** lets old classes map onto the same resolved values, so a half-migrated screen never mixes two truths.
- Screens migrate to the new vocabulary in W1–W3. After the ecosystem is migrated, deprecated aliases can be removed in a later, separate clean-cut (out of scope here).
- **Risk (called out explicitly):** the new namespaced names (`bg-bg-fill`, `text-text-tertiary`) differ from the shadcn convention currently used by the web apps (auth/console/inbox) and the NativeWind classes used by services/Mention/etc. This is an ecosystem-wide vocabulary addition. We mitigate by making it additive and migrating screen-by-screen with per-screen verification — never a flag-day rename.

## 4. New Bloom components (W0b)

Generic, className-driven, RN + web (platform forks where needed per Bloom's `.native`/`.web` pattern).

1. **`TextField` `floatingLabel` variant** *(approved)*. Prop on `TextFieldInput` (`floatingLabel`), reusing existing chrome/focus/error/disabled/accessibility. Label sits as placeholder when empty+blurred; animates to a top caption on focus or when filled. Native: implemented with focus state + value state + Animated/Reanimated (NativeWind cannot use `peer-focus`/`:placeholder-shown`). Web: same behavior via state (not CSS `:placeholder-shown`) so RN and web match.
2. **`ConnectionDots` / `PairedLogos`** — the consent header: `logoA · (animated ellipsis dots) · logoB`. Generic "connecting two parties" indicator. Animated dots via Bloom's animation primitives; className-styled. Used by the auth authorize screen and any future "connect account" flow.
3. **`BenefitRow` / `FeatureList`** — icon-circle (`icon-circle`) + caption rows inside a bordered card. Likely a thin composition helper over existing Bloom (`icon-circle` + `card` + `Text`); promoted to a named Bloom component only if reused. If it stays a one-screen shape, it lives in oxy-services instead (see §6 placement rule).
4. **Others as discovered** — any further generic primitive the flagship screens need (e.g. a labeled "detail row" with chevron if not already covered by `SettingsList`). Each is greenlit case-by-case using the placement rule; the user has pre-approved building "los que sean necesarios."

Anything Oxy-product-specific (a name-detail row bound to the profile contract, the welcome name form, consent copy/layout specific to Oxy) lives in **oxy-services** as a composite that consumes Bloom — and may expose its own variants.

## 5. Flagship screens (set the bar)

### W1 — oxy-auth authorize / consent (`packages/auth/src/pages/authorize.tsx`)
Redesign to the "Connect account" reference using Bloom:
- Header: `ConnectionDots` with the RP app logo (`PublicApplication`) and the Oxy logo.
- Title (`sectionTitle`) + subtitle (`bodySmall`, `text-tertiary`), centered.
- Benefits card (`BenefitRow`/`FeatureList`) — 3 icon+caption rows in a `border-image` + `shadow-s` card.
- Primary full-width `Button` ("Continue to …") + disclaimer caption.
- Keep all existing IdP logic intact: `useDeviceAccounts`, `AccountChooser`, `sessionStatusSchema`/`safeParse`, the real `PublicApplication` identity, approval/redirect flow. This is a **visual** redesign over unchanged auth behavior. (Web app uses Bloom web + the new token classes; translate the current shadcn classes.) — *Historical note, twice revised: `useDeviceAccounts` was deleted in the zero-cookie cutover (2026-07-07) and replaced by `useSwitchableAccounts`, which was itself deleted in issue #937 (2026-08-10) when the switcher moved onto the server's device directory. The hook to target today is `useDeviceSwitcher` (`@oxyhq/services`). The visual-redesign intent of this spec still stands; the hook name in it has now been wrong twice, so read it as "whatever the chooser's data source is called", not as an identifier.*

### W2 — oxy-services Welcome (`WelcomeNewUserScreen.tsx`)
- Apply the design language; swap the name-step inputs to the floating `TextField` variant once W0b ships.
- Keep the already-shipped structure (conditional required name step, gating, save, skip, icon-free Bloom buttons).

These two screens are the reference implementations the fan-out copies.

## 6. Big-bang fan-out (W3)

After W0 lands and the two flagship screens set the bar:
- Convert the remaining ~29 oxy-services screens + the rest of `packages/auth` to the language: Bloom components + new token classes, `className`-only, no `StyleSheet`/inline.
- Parallel agents, **one screen (or small cluster) per agent**, each against the **locked W0 standard + the two flagship references** so output converges instead of diverging.
- Per-screen guardrails (see §8). Each agent builds + tests its package and reports; no screen is "done" without a green build and a visual check where feasible.

## 7. Architecture / data flow

- No behavioral/data changes. This program is presentation-only: tokens, component composition, and class usage. Auth flows, profile mutations, navigation, SSO, and contracts are untouched.
- Bloom remains the single source of resolved theme values; the new classes are a naming layer over `getResolvedTokens`/`ThemeColors` + new numeric scales.
- oxy-services composites import Bloom primitives; they never re-implement primitives or redefine tokens.

## 8. Guardrails & verification

- **No foreign tokens.** The reference class names are a *visual target*; the implementation uses Bloom's vocabulary only.
- **No `StyleSheet.create` / inline `style`** in migrated consumer screens where a class exists. Allowed exceptions: Reanimated/Animated transforms, dynamically measured values.
- **No `as any`, `@ts-ignore`, `!`, hardcoded colors/hex, magic numbers** (existing AGENTS rules).
- **Per package:** `bun run build` (services/bloom) must exit 0; package tests pass; web apps `tsc --noEmit` clean.
- **Runtime check** on web (localhost test app / auth dev) for the flagship screens — static build does not catch NativeWind/Tailwind token-resolution bugs (documented incident class).
- **Bloom releases** are published + the monorepo bumped (root `overrides` included) per the standing "always latest Bloom" rule.

## 9. Execution order

1. **W0a** — Bloom token layer (semantic vocabulary, reference-style names, additive, mapped to resolver). Publish Bloom, bump.
2. **W0b** — new Bloom primitives (`floatingLabel`, `ConnectionDots`, `BenefitRow` if generic). Publish Bloom, bump.
3. **W1 + W2** in parallel — flagship authorize + welcome on the locked foundation.
4. **W3** — big-bang fan-out across remaining screens, parallel agents against the standard.

Each of W0a, W0b, W1/W2, W3 is its own implement → verify → (publish/bump where Bloom) cycle; we stay in the loop between them.

## 10. Open questions / risks

- **Exact value tables** (color mapping, type scale sizes, spacing/radius/shadow values) are finalized in W0a from Bloom's resolver + the reference; the tables above are the contract shape.
- **Vocabulary divergence risk** (§3.6) — additive + screen-by-screen migration mitigates; full removal of old aliases is a later separate effort.
- **Web vs native parity** for floating label, shadows, and animations — Bloom owns the platform split so consumers write one class; verified at runtime on both.
- **Scale** — ~29 services screens + auth screens is large; W3 is intentionally the last phase so the standard is fixed before fan-out.
