# ADR 0064 — A platform's setup composes with the SDK's sign-in: `OxySetupFlow`

- Status: accepted (2026-11-08). Built in `@oxy.so/services` 14.16.0
  (`packages/services/src/ui/components/setupFlow/`).
- Date: 2026-11-08
- Decided by: the owner (2026-11-08): OxyOS sets a new account up at its login
  screen as macOS's Setup Assistant does, and the sign-in step is the SDK's own
  chooser, extended through a supported composition API, not forked.
- Builds on: [0030](0030-email-code-password-authenticator.md) (how an account
  signs in), [0058](0058-platform-held-session.md) (a platform's setup client
  and its `authStateStore`). Companion: OxyOS ADR 0020 (the Oxy account at the
  login screen; decision 4: the SDK's sign-in on the login screen's card).

## Context

OxyOS's first run is a sequence: Welcome, Sign in with Oxy (the QR a phone
approves, or typed), Create a PIN, Appearance, "Setting up your account…",
Done. Every step but one is OxyOS's; the sign-in is Oxy's, and it must be the
SDK's `OxyAuthChooser` — the screens every Oxy app's account dialog shows, the
split card with the Commons QR from `md` — so that a person signs in to OxyOS
exactly as they sign in everywhere else, and every fix to the sign-in reaches
OxyOS by a version bump.

Mounting the chooser bare on the login card (`OxySurfaceFrame`, services
14.15) gave the sign-in but not the sequence: OxyOS's own steps were drawn by
OxyOS in its own frame, so the one step that was Oxy's looked like a different
product from the steps around it, and a header, a footer and a transition
would have been written twice, drifting apart.

## Decision

1. **The SDK owns the frame; the host owns the flow.** `OxySetupFlow` is
   controlled and presentational: the host passes its `steps`, the `current`
   step's id, `onBack`, and each step's `primary` and `secondary` actions, and
   decides which steps apply, what each action does and when the flow moves.
   The SDK keeps no step state and calls no Oxy API from the frame. A host's
   setup has facts the SDK cannot know (a PIN, a local account, a seat), so
   the sequence cannot be the SDK's; the look can.
2. **Every step is drawn in the sign-in's shell** (`OxyAuthScreen`): the step's
   icon or the Oxy mark, the 48/800 title and 18px description, blocks 24
   apart, 448 wide; a step with an `aside` is the sign-in's split card from
   `md` and asks its surface for 880, as the sign-in's QR side does. Below
   them, quiet progress ("Step 2 of 5", decorative dots) and the footer: Back
   leading, the secondary and the primary trailing (the default action).
3. **The sign-in step is the chooser, unchanged.** `oxySignInStep()` returns a
   step whose content is `<OxyAuthChooser />`, untitled (its screens bring
   their own headers) and leaving focus to them. The flow provides the
   surface-width context the chooser already asks (`useSurfaceFrameWidth`), so
   the card grows to the split's 880 for that step and returns after, reported
   through `onMaxWidthChange` as `OxySurfaceFrame` reports it. Nothing about
   the chooser's behaviour changes, and there is no setup variant of it.
4. **One seam for what the sign-in produced.** The host learns the sign-in
   through `OxyProvider`'s `authStateStore` (`PlatformSetupAuthStateStore`,
   `save(state, context)` with `context.method` and the typed password,
   services 14.15.2) and follows the account through `useOxy()`. The flow adds
   no callback that reports a sign-in.
5. **Accessibility and motion are the frame's.** A step change moves focus to
   the new title (Bloom's native focus move; the browser's focus on the web)
   unless the step says its content takes it (`initialFocus: 'content'`), and
   is said politely ("Create a PIN, step 3 of 5": the platform's announcement
   on native, queued on iOS; a polite live region on the web). The dots are
   hidden from assistive technology. The change is Bloom's `ScreenTransition`,
   none under Bloom's reduced-motion reading.
6. **The flow's words speak the host's language when it names one**
   (`locale`, services 14.17.0). Once signed in, the runtime follows the
   account's own language (ADR 0022); a platform's setup is in its system's
   language from the first step to the last (OxyOS ADR 0040), so its host
   passes that locale and the flow's progress, announcements and default Back
   keep it after the sign-in. Without `locale`, the runtime's.

## Alternatives rejected

- **A setup variant of the chooser** (props that add host steps inside it): the
  chooser is a state machine bound to `AccountDialogController`; host steps in
  it would make every Oxy app's sign-in carry OxyOS's setup.
- **An uncontrolled wizard owning the step state**: the host's steps depend on
  what the sign-in returned (a password typed or not, OxyOS ADR 0020 decision
  2), which only the host reads; an SDK-owned sequence would need callbacks
  for every such branch.
- **Bloom's `WizardFooter`/`WizardProgress`**: a page's footer (sticky, a
  hairline, the page background) and a full-width segmented bar — chrome for a
  page, not for the sign-in's card. The footer uses Bloom's `Button`s; the
  progress Bloom's decorative `CarouselDots`.

## Consequences

- OxyOS's login screen draws its setup with `OxySetupFlow` inside `OxyProvider`
  and sizes its card from `onMaxWidthChange`; its own steps are content.
- A change to the sign-in's shell (the header, the split) reaches every setup
  step with it.
- The announcement's words are core's (`common.stepAnnouncement`, core 7.45.0).
