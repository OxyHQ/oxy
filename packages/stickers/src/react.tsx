/**
 * `@oxy.so/stickers/react` — the catalogue as React Query hooks.
 *
 * Mount one provider with a client built on the app's `OxyServices`, inside
 * the app's `QueryClientProvider`:
 *
 * ```tsx
 * const stickers = createStickersClient(oxyServices);
 * <StickersProvider client={stickers}>…</StickersProvider>
 * ```
 *
 * The provider takes a client rather than reaching for `@oxy.so/services`
 * itself, so an app that talks to Oxy some other way can still use the hooks.
 *
 * Catalogue reads are cached for a long time: a published sticker never
 * changes, only new ones appear. The picker (`useInstalledStickerPacks`) is
 * the person's own state and is refetched whenever it is changed here.
 */

import { createContext, useContext, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { InstalledStickerPack, Sticker, StickerPack } from '@oxy.so/contracts';
import type { StickerPackPage, StickersClient } from './client';

const StickersContext = createContext<StickersClient | null>(null);

export function StickersProvider({
  client,
  children,
}: {
  client: StickersClient;
  children: ReactNode;
}) {
  return <StickersContext.Provider value={client}>{children}</StickersContext.Provider>;
}

export function useStickersClient(): StickersClient {
  const client = useContext(StickersContext);
  if (!client) throw new Error('useStickersClient must be used inside <StickersProvider>');
  return client;
}

/** Query keys, exported so an app can prefetch or invalidate them. */
export const stickerKeys = {
  all: ['oxy-stickers'] as const,
  sticker: (id: string) => ['oxy-stickers', 'sticker', id] as const,
  pack: (slug: string) => ['oxy-stickers', 'pack', slug] as const,
  shop: (offset: number, limit: number) => ['oxy-stickers', 'shop', offset, limit] as const,
  search: (term: string) => ['oxy-stickers', 'search', term] as const,
  installed: ['oxy-stickers', 'installed'] as const,
};

const CATALOGUE_STALE_MS = 60 * 60 * 1000;

/** One sticker by id — what an empty state or a chat bubble needs. */
export function useSticker(id: string | null | undefined): UseQueryResult<Sticker | null> {
  const client = useStickersClient();
  return useQuery({
    queryKey: stickerKeys.sticker(id ?? ''),
    queryFn: () => client.getSticker(id ?? ''),
    enabled: Boolean(id),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: CATALOGUE_STALE_MS,
  });
}

/** One pack with every sticker. */
export function useStickerPack(
  slug: string | null | undefined,
): UseQueryResult<StickerPack | null> {
  const client = useStickersClient();
  return useQuery({
    queryKey: stickerKeys.pack(slug ?? ''),
    queryFn: () => client.getPack(slug ?? ''),
    enabled: Boolean(slug),
    staleTime: CATALOGUE_STALE_MS,
  });
}

/** A page of the shop. */
export function useStickerShop(
  options: { offset?: number; limit?: number } = {},
): UseQueryResult<StickerPackPage> {
  const client = useStickersClient();
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 24;
  return useQuery({
    queryKey: stickerKeys.shop(offset, limit),
    queryFn: () => client.listPacks({ offset, limit }),
    staleTime: CATALOGUE_STALE_MS,
  });
}

/** Stickers for an emoji — the "suggest a sticker" row under a composer. */
export function useStickerSearch(emoji: string | null | undefined): UseQueryResult<Sticker[]> {
  const client = useStickersClient();
  return useQuery({
    queryKey: stickerKeys.search(emoji ?? ''),
    queryFn: () => client.search({ emoji: emoji ?? '' }),
    enabled: Boolean(emoji),
    staleTime: CATALOGUE_STALE_MS,
  });
}

/** The signed-in person's picker. Pass `enabled: false` while signed out. */
export function useInstalledStickerPacks(
  options: { enabled?: boolean } = {},
): UseQueryResult<InstalledStickerPack[]> {
  const client = useStickersClient();
  return useQuery({
    queryKey: stickerKeys.installed,
    queryFn: () => client.installedPacks(),
    enabled: options.enabled ?? true,
    staleTime: 5 * 60 * 1000,
  });
}

function usePickerMutation<TInput>(run: (client: StickersClient, input: TInput) => Promise<void>) {
  const client = useStickersClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => run(client, input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: stickerKeys.installed }),
  });
}

export function useInstallStickerPack() {
  return usePickerMutation<string>((client, packId) => client.install(packId));
}

export function useUninstallStickerPack() {
  return usePickerMutation<string>((client, packId) => client.uninstall(packId));
}

export function useReorderStickerPacks() {
  return usePickerMutation<readonly string[]>((client, packIds) => client.reorder(packIds));
}
