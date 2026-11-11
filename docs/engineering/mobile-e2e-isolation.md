# Isolated mobile end-to-end tests

A mobile end-to-end test must never contact a real service, use a real account, or touch a physical device. Running an installed app with its default settings does not satisfy this: every Oxy app points its identity, product and media endpoints at production by default, and changing one URL does not isolate the app. Isolation is a property that has to be demonstrated, and a visual test that passes says nothing about it.

## Requirements

- **A disposable device.** Each run uses a fresh, ephemeral emulator or simulator with no user data and a test-only application id that differs from every installed app. Select the device explicitly by serial number on every command; refuse zero or more than one selected device and refuse any physical device. Never clear data, uninstall apps or change settings on a device a person uses.
- **A test build with synthetic fixtures.** The build is explicit about its environment and runs against synthetic identity and product fixtures with no real credentials or accounts. Inventory every HTTP, WebSocket, media and SDK destination; any destination that is not configured fails closed instead of falling back to production. Test preferences and keys stay inside the ephemeral package.
- **A network boundary that is proven.** Isolate the test process's network, allowing only the fixture servers (and the bundler in development). A negative test must show that connections to external destinations fail, including DNS and WebSocket. Configuration alone does not prove isolation, and how the boundary is implemented depends on the CI environment, so prove it before trusting a product binary.
- **Fixtures that fail loudly.** Fixtures record unexpected requests as errors and never accept writes that would reach an external service.
- **A pinned runner.** Install a pinned, verified version of the flow runner (for example Maestro) in CI and start with a minimal flow: launch, a synthetic signed-in screen, navigation, and dismissing a dialog.

## Acceptance before enabling in CI

- The isolation test fails deliberately if a physical device, a real account or an external URL is used, even when the visual test would pass.
- Test data does not survive outside the ephemeral device and package.
- The same flow passes two clean runs on Android. iOS needs its own simulator flow on a macOS runner; no result is extrapolated across platforms.
- Apps using the shared infrastructure declare their fixtures and their network contract, and services and permissions a flow does not need stay closed.

## What is shared and what is not

Share the emulator bootstrap, the device preflight and the network boundary across apps. UI identifiers, domain data and flows stay with each product. Publish results, the build version and any isolation failure as CI artefacts. This setup is not a test of screen readers, haptics or performance, which need a physical device.

Existing web gates that mix fixtures with real reads, or that intercept in the browser, do not demonstrate isolation of a native app.
