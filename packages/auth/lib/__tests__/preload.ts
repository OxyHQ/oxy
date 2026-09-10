/**
 * `bun test` preload entry. Order matters:
 *   1. the contracts-source resolver is registered FIRST so `@oxy.so/contracts`
 *      resolves from source (not the built `dist/`) for every test file and
 *      transitive import — the suite no longer depends on workspace build order;
 *   2. module mocks are registered next so any static imports in test files (or
 *      their transitive deps) resolve to the stubbed surface;
 *   3. the DOM environment is set up last so React + the components have
 *      `window` / `document` to render into.
 */
import "./setup-contracts-source"
import "./setup-core-source"
import "./setup-services-mock"
import "./setup-mocks"
import "./setup-dom"
