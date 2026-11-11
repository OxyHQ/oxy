# Lint and format: Biome

Every Oxy JS/TS repository formats and lints with Biome. The version is pinned per repository in its root `package.json` (`@biomejs/biome`) and in the `$schema` URL of its Biome config; repositories do not all sit on the same release, and a bump is an ordinary dependency update. Each repository has a root `biome.json` or `biome.jsonc` built from the same base: single quotes, semicolons, 2 spaces, line width 100, `"preset": "recommended"`, and `organizeImports` off. VCS integration is on with `useIgnoreFile`.

Commands are the standard root scripts in [standards.md](standards.md): `bun run lint` (`biome check .`), `bun run lint:fix`, `bun run format`. CI runs `biome ci .`, which never writes. The mass-format commit of each repository is listed in its `.git-blame-ignore-revs`.

Rules that were warnings or absent when a repository adopted Biome were baselined to `warn` instead of fixed, with a comment in the config. Tightening them is follow-up work; do not widen the baseline.

## What still runs ESLint, and why

- **Expo frontends:** a minimal `eslint.config.js` keeping only what Biome has no equivalent for: `eslint-plugin-expo`'s `no-env-var-destructuring` and `no-dynamic-env-var` (they catch `EXPO_PUBLIC_*` reads that Metro cannot inline and silently ships as `undefined`), and in some repositories the React Compiler rules from `eslint-plugin-react-hooks`. The repository's root `lint` script runs that package's `lint` after Biome. Repositories whose app never had ESLint use GritQL plugins instead (`biome-plugins/*.grit`, for example Alia, Moovo and Noted).
- **`@oxy.so/app-preset/eslint` and the `create-oxy-app` templates** still ship a full ESLint configuration, because they serve other apps; a scaffolded app trims it to the minimal form above.
- **Repositories with a non-Expo ESLint need** (for example the website) run `eslint .` after Biome in `lint`.

## Traps

- **Ignore worktrees with `"!.worktrees"`, never `"!**/.worktrees"`.** The `**/` form matches the worktree's own path, so a run inside `<repo>/.worktrees/<name>` checks zero files and passes vacuously.
- **Run the formatter until a pass changes nothing.** Some Biome releases only settle member chains and comment-after-`case` blocks on a second pass, so a single `format --write` can leave `biome ci` red.
- **Bare `bunx biome` without `@biomejs/biome` installed fetches npm's unrelated `biome` package** (an env-var manager), which lints nothing. Run Biome after `bun install`, call `./node_modules/.bin/biome`, or use `bunx @biomejs/biome@<pinned version>`. A CI log without Biome's `Checked N files` line means Biome did not run.
- **Bare `expo lint` only covers `app/`, `components/` and `src/`.** It skips files such as `lib/config.ts`, where `EXPO_PUBLIC_*` reads live. Use `expo lint .`.
- **Tests and gates that read source as text break on reformatting** (quote style, wrapping): regex or `toContain` source tests, mutation anchors, sha256-pinned files, byte-for-byte generated output, bundle-size budgets, i18n catalogs that must equal `JSON.stringify(x, null, 2)`. Exclude those files from the formatter in the Biome config with a reason beside each, or update the reader before formatting the file.
- **Squash-only merge queues rewrite the format commit's SHA.** After the merge, point `.git-blame-ignore-revs` at the squash commit in a follow-up PR.
- **Write PR bodies with the Write tool or a quoted heredoc (`<<'EOF'`).** An unquoted heredoc executes every backticked command in the body.
