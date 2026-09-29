# Changelog: `@oxy.so/stickers`

## 0.1.1

### Changed

- Nothing loads `@oxy.so/contracts` at runtime any more — only its types — so
  importing the client does not evaluate zod. The schema and limit re-exports
  are gone from the root; import them from `@oxy.so/contracts` directly.

## 0.1.0

### Added

- `createStickersClient(oxy)`: the catalogue (`listPacks`, `getPack`,
  `getSticker`, `resolve`, `search`), the signed-in person's picker
  (`installedPacks`, `install`, `uninstall`, `reorder`) and `refOf`. Resolved
  stickers are memoized per client, since a published sticker never changes.
- `verifyStickerBytes`: check fetched animation bytes against a `StickerRef`.
- `@oxy.so/stickers/react`: `StickersProvider` and React Query hooks.
