# @oxy.so/stickers

Oxy's shared sticker catalogue. Allo sends stickers in chats, Mention draws
them in empty states, and any other Oxy app can do either: a sticker is a
stable id that resolves to the same Lottie animation everywhere, served from
Oxy's CDN.

## In an app

```tsx
import { createStickersClient } from '@oxy.so/stickers';
import { StickersProvider, useSticker, useInstalledStickerPacks } from '@oxy.so/stickers/react';

const stickers = createStickersClient(oxyServices);

<QueryClientProvider client={queryClient}>
  <StickersProvider client={stickers}>
    <App />
  </StickersProvider>
</QueryClientProvider>;

const { data: sticker } = useSticker(stickerId);        // sticker.animation.url, sticker.fallback.url
const { data: packs } = useInstalledStickerPacks();     // the person's picker, shared across apps
```

Hooks: `useSticker`, `useStickerPack`, `useStickerShop`, `useStickerSearch`,
`useInstalledStickerPacks`, `useInstallStickerPack`, `useUninstallStickerPack`,
`useReorderStickerPacks`.

## In a backend

Catalogue reads are public, so a backend checks an id a client sent with its
ordinary client — no service token:

```ts
const stickers = createStickersClient(oxy);
const found = await stickers.resolve(ids);
if (!found.has(id)) throw new BadRequestError('Unknown sticker');
```

## Storing or sending a sticker

Store the `StickerRef` (`stickers.refOf(sticker)`): the sticker id, its pack,
and the SHA-256 of its animation. In an end-to-end encrypted chat the receiver
checks the bytes it fetched with `verifyStickerBytes(ref, bytes)` — pass a
SHA-256 implementation on React Native, which has no `crypto.subtle`.

## Files

Every sticker has an `animation` (Lottie JSON, square 512 or 1024 canvas) and a
`fallback` (512×512 WebP) for surfaces that cannot animate: notifications,
federation, reduced motion. Both URLs are immutable and cacheable forever.
