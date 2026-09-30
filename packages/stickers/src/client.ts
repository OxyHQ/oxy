/**
 * The sticker catalogue client.
 *
 * Built on an existing `OxyServices` (or anything with its `request`), so it
 * inherits that client's session, base URL and error type rather than keeping
 * its own: in an app it acts as the signed-in person, in a backend it is the
 * backend's client. Every catalogue read is public, so a backend needs no
 * service token to resolve a sticker id a client sent it.
 *
 * Stickers are immutable once published — a new drawing is a new sticker id —
 * so resolved stickers are memoized for the life of the client and a chat
 * screen that shows the same sticker fifty times asks once.
 */

import type {
  InstalledStickerPack,
  Sticker,
  StickerPack,
  StickerPackSummary,
  StickerRef,
} from '@oxy.so/contracts';

/**
 * How many ids one `POST /stickers/resolve` may carry — `STICKER_RESOLVE_MAX_IDS`
 * in `@oxy.so/contracts`, restated so this module imports contracts for TYPES
 * only. Contracts is zod schemas, and an app that draws one sticker in an empty
 * state should not evaluate zod at startup to do it. A test pins the two equal.
 */
export const RESOLVE_BATCH_SIZE = 100;

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** The one thing this client needs from `OxyServices`. */
export interface StickersTransport {
  request<T>(method: HttpMethod, url: string, data?: unknown, options?: { cache?: boolean }): Promise<T>;
}

export interface StickerPackPage {
  items: StickerPackSummary[];
  total: number;
  hasMore: boolean;
}

export interface StickersClient {
  /** The shop: published packs, newest first. */
  listPacks(options?: { limit?: number; offset?: number }): Promise<StickerPackPage>;
  /** One pack with every sticker, or `null` if there is no such published or archived pack. */
  getPack(slug: string): Promise<StickerPack | null>;
  /** One sticker, or `null` if the id is unknown. */
  getSticker(id: string): Promise<Sticker | null>;
  /**
   * Many stickers by id, in one request per 100 unseen ids. Unknown ids are
   * absent from the map — a backend checks `has(id)` before storing one.
   */
  resolve(ids: readonly string[]): Promise<Map<string, Sticker>>;
  /** Stickers from published packs for an emoji, or for a keyword. */
  search(query: { emoji: string } | { q: string }, options?: { limit?: number }): Promise<Sticker[]>;

  /** The signed-in person's picker, in their order. */
  installedPacks(): Promise<InstalledStickerPack[]>;
  install(packId: string): Promise<void>;
  uninstall(packId: string): Promise<void>;
  /** The full installed list, first to last. */
  reorder(packIds: readonly string[]): Promise<void>;

  /** What an app stores or sends for a sticker. */
  refOf(sticker: Sticker): StickerRef;
}

const enc = encodeURIComponent;

/** Resolved stickers kept per client. Far above any screen's worth, small in memory. */
const MEMO_LIMIT = 2000;

function is404(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const status = (error as { status?: unknown; statusCode?: unknown }).status
    ?? (error as { statusCode?: unknown }).statusCode;
  return status === 404;
}

export function createStickersClient(oxy: StickersTransport): StickersClient {
  const memo = new Map<string, Sticker>();

  const remember = (sticker: Sticker): void => {
    if (memo.size >= MEMO_LIMIT) {
      const oldest = memo.keys().next().value;
      if (oldest !== undefined) memo.delete(oldest);
    }
    memo.set(sticker.id, sticker);
  };
  const rememberAll = (stickers: readonly Sticker[]): void => {
    for (const sticker of stickers) remember(sticker);
  };

  return {
    async listPacks(options = {}) {
      const limit = options.limit ?? 24;
      const offset = options.offset ?? 0;
      const page = await oxy.request<{ data?: StickerPackSummary[]; pagination?: { total?: number; hasMore?: boolean } }>(
        'GET',
        `/stickers/packs?limit=${limit}&offset=${offset}`
      );
      const items = page.data ?? [];
      for (const pack of items) if (pack.cover) remember(pack.cover);
      return { items, total: page.pagination?.total ?? items.length, hasMore: page.pagination?.hasMore ?? false };
    },

    async getPack(slug) {
      try {
        const pack = await oxy.request<StickerPack>('GET', `/stickers/packs/${enc(slug)}`);
        rememberAll(pack.stickers);
        return pack;
      } catch (error) {
        if (is404(error)) return null;
        throw error;
      }
    },

    async getSticker(id) {
      return (await this.resolve([id])).get(id) ?? null;
    },

    async resolve(ids) {
      const result = new Map<string, Sticker>();
      const missing: string[] = [];
      for (const id of new Set(ids)) {
        const known = memo.get(id);
        if (known) result.set(id, known);
        else missing.push(id);
      }
      for (let start = 0; start < missing.length; start += RESOLVE_BATCH_SIZE) {
        const batch = missing.slice(start, start + RESOLVE_BATCH_SIZE);
        const { stickers } = await oxy.request<{ stickers: Sticker[] }>('POST', '/stickers/resolve', { ids: batch });
        for (const sticker of stickers) {
          remember(sticker);
          result.set(sticker.id, sticker);
        }
      }
      return result;
    },

    async search(query, options = {}) {
      const params = new URLSearchParams();
      if ('emoji' in query) params.set('emoji', query.emoji);
      else params.set('q', query.q);
      params.set('limit', String(options.limit ?? 40));
      const { stickers } = await oxy.request<{ stickers: Sticker[] }>('GET', `/stickers/search?${params.toString()}`);
      rememberAll(stickers);
      return stickers;
    },

    async installedPacks() {
      const packs = await oxy.request<InstalledStickerPack[]>('GET', '/stickers/me/packs', undefined, { cache: false });
      for (const pack of packs) rememberAll(pack.stickers);
      return packs;
    },

    async install(packId) {
      await oxy.request<void>('PUT', `/stickers/me/packs/${enc(packId)}`, undefined, { cache: false });
    },

    async uninstall(packId) {
      await oxy.request<void>('DELETE', `/stickers/me/packs/${enc(packId)}`, undefined, { cache: false });
    },

    async reorder(packIds) {
      await oxy.request<void>('PATCH', '/stickers/me/packs-order', { packIds: [...packIds] }, { cache: false });
    },

    refOf(sticker) {
      return { stickerId: sticker.id, packId: sticker.packId, sha256: sticker.animation.sha256 };
    },
  };
}
