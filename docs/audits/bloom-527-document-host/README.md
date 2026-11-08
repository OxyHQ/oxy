# Expo document host follow-up for Bloom #527 / #663

## Scope and result

A generated Expo SPA disables browser document scrolling through its default
`body { overflow: hidden }` reset. In a published Bloom 17.22.0 document Screen,
content reached 3896 CSS px but real wheel input left `scrollY` at zero. Enabling
body overflow allowed the same tree to scroll to 650. No layout heights or Bloom
scroll-owner code needed to change.

The candidate adds an explicit `@oxy.so/app-preset/css/document-scroll.css`
subpath containing `html body { overflow: auto }`. The selector wins over Expo's
body reset without relying on import order. The base stylesheet and Expo reset
remain unchanged. The initial browser experiment used a **local packed source candidate** labeled
6.5.1; it was never the published 6.5.1 package. The PR now prepares the additive
6.6.0 release with its synchronized lockfile and changelog. `release-6.6.0.json`
records the final packed artifact and confirms identical CSS bytes; publication
and final published-package consumer acceptance remain pending.

## Baseline and integration fixture

Source: Oxy main `a3c6bcabb20240bf24c377bc4f632ab683e7daba`.
`buildRenderContext` + `renderTree` generated the complete base scaffold (49
files), with backend/deploy/demo/install/git/register disabled. Synthetic app
name/domain/client ID were used; API traffic was directed to localhost:9.

The untouched generated scaffold installed Bloom 11.1.1, Services 12.14.0, Core
6.17.0, preset 3.6.1, Expo 58.0.23 and router 58.0.30. Its frontend typecheck and
web export passed; Chromium displayed the sign-in screen without page errors.
Old version ranges alone are therefore not evidence that it is broken.

A separately generated fixture pinned the registry-verified published set:
Bloom 17.22.0, Services 14.15.2, Core 7.44.0, Contracts 6.22.0 and preset 6.5.1.
Their required first-party peer ranges are compatible. The existing provider,
router, CSS and HTML shells remained; only the auth route was replaced by the
synthetic `HostProbe.tsx.txt` and the first-party dependency declarations/overrides
changed. The published fixture passed typecheck/export before the CSS experiment.

`web.output="single"` emits Expo's generic HTML, including `expo-reset`; it does
not render the scaffold's custom `+html.tsx`. An opt-in attribute only on that
custom document would not configure this SPA. The proposed import is in the
normal stylesheet, which is emitted by both hosts.

For the candidate, `bun pm pack --ignore-scripts` packed the actual preset and
Bun installed that tarball into the separate fixture. The fixture imported the
new CSS export after base.css and rebuilt its web export. No node_modules file
was patched. `receipt.json` records exact versions, lock/HTML/CSS hashes and the
tarball hash; the installed candidate CSS equals the source CSS byte-for-byte.

## Executed checks

- App preset: **128 tests passed**, no skips (`preset-tests.txt`).
- Original, published integration, and final candidate frontend TypeScript passed.
- Original and candidate Expo web exports passed. Candidate uses the real emitted
  stylesheet, not a browser-injected fix.
- Chromium at 320×844, 390×844, 1100×844, plus a 320-wide host centered inside the
  1100-wide viewport: **eight valid document/bounded cases**, no page errors,
  document `scrollWidth === clientWidth` before/after flow changes.
- Document owner: wheel 0→650; bounded owner: document remains 0 and internal
  scroller moves 0→650.
- Dialog opens at offset 650, changes body overflow from auto to hidden, and
  background wheel does not change the owner offset. Close restores auto and
  the same offset; wheel resumes to 850. Bloom's Dialog uses RemoveScrollBar's
  `body[data-scroll-locked]` rule with `!important`, which wins over the opt-in.
- Switching document↔bounded within the same retained tree transfers offset 850
  to the correct owner; the next wheel moves it to 1150. This is a flow switch,
  not a claim about router Back/Forward restoration.

See `matrix-summary.json`, per-case JSON, and before/after/Dialog PNGs. The
unmodified published host comparison is `published-host-report.json`.

Two harness negatives were excluded: initial query-selected mode was lost by
auth redirection (`query-mode-negative.json`), so the final fixture uses a visible
button and asserts the mode title. The first centered-host wheel used x=180,
outside the host at x=390..710; the final runner computes the host's horizontal
center before sending wheel input. Only the corrected run is in the matrix.

## Reproduce

Generate the base template with `renderTree` and the context above. Keep one
untouched copy; in a second copy pin the published versions listed above across
dependencies/overrides/resolutions, then replace `app/(auth)/index.tsx` with
`HostProbe.tsx.txt`. Install each project independently with
`bun install --minimum-release-age=0` and run the frontend's `bun run typecheck`.

Pack the candidate from `packages/app-preset` using `bun pm pack --ignore-scripts
--filename <absolute-tarball-path>`, install its file dependency in the integration
fixture, and add the documented CSS import. Export with:

```sh
EXPO_PUBLIC_API_URL=http://localhost:9 EXPO_PUBLIC_OXY_CLIENT_ID=document-host-fixture \
EXPO_NO_TELEMETRY=1 bun run export:web --max-workers 2
```

Serve `packages/frontend/dist` on localhost:8145. With an installed Playwright
module/Chromium, run `verify-host.cjs` with `PLAYWRIGHT_MODULE`, `HOST_URL`, a fresh
`OUTPUT_DIR` and `VIEWPORT_WIDTH` (320, 390 or 1100). Set `HOST_WIDTH=320` for the
embedded desktop case. The runner asserts real wheel movement, mode visibility,
Dialog locking/restoration and no horizontal overflow.

## Pending

No package publication, consumer adoption, generated-version refresh, router
Back/Forward verification, static-output export, Firefox/WebKit or physical
mobile pass is claimed. iPhone remains deferred. The Atlas short-page bottom
paint criterion in #527 is separate and is not closed by this host correction.
