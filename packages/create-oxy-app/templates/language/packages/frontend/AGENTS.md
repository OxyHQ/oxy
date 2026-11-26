# Frontend: the Bloom language

Screens are written in the Bloom language (`@oxy.so/bloom-language`): a view is a function, its look a chain of modifiers whose values are Bloom tokens. Read before writing UI:

- `node_modules/@oxy.so/bloom/docs/bloom-language-for-agents.mdx`: the cheat sheet (nodes, modifiers, tokens, bindings, router).
- `node_modules/@oxy.so/bloom/docs/bloom-language-tour.mdx`: a tour of the language; `bloom-language.mdx` beside it is the full reference, `bloom-data.mdx` the data layer.

## Rules

- No `className`, NativeWind, Tailwind, react-native-css or `global.css`; never add `nativewind` (app-preset would wrap Metro in it again).
- Route files default-export `layout()` or `screen()` from `@oxy.so/bloom-language/router`; screen chrome is modifiers on the body's root (`.title`, `.toolbar`, `.footer`, `.sheet`). `app/_layout.tsx` holds the providers and the auth gate.
- Values are tokens (`'md'`, `'muted'`, `'title-2'`), never pixels or colours; a value the spec lacks belongs in Bloom, not inline styles.
- Inputs take a binding, `[value, setValue]` (`useState`). Presses that navigate use `navigate(href, params)`.
- Reusable views are `view(function Name(props) { ... })`; hooks go in the body, controllers in a custom hook.
- Glass is the navigation layer only (headers, toolbars, bars): adjacent glass in one `GlassGroup`, at most one tinted per group, every icon-only button `.label()`ed.
- App data is `@oxy.so/bloom-data` (`lib/notes.ts`): entities, lists, sources and actions; no React Query or zustand for it.
- Embed a component that has no node with `Embed(<Component />)`; prefer adding the node to Bloom.
- `bun run test` runs Jest through the language compiler, which fails on an unknown modifier or token, as Metro does.
