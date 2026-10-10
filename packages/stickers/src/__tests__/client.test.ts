/**
 * @jest-environment node
 */
import { createHash, webcrypto } from 'node:crypto';
import type { Sticker } from '@oxy.so/contracts';
import { createStickersClient, type StickersTransport } from '../client';
import { verifyStickerBytes } from '../verify';

function sticker(id: string, packId = 'pack-1'): Sticker {
  return {
    id,
    packId,
    emoji: ['😀'],
    keywords: [],
    size: 512,
    durationMs: 2000,
    animation: {
      url: `https://cloud.oxy.so/content/${id}.json`,
      sha256: 'a'.repeat(64),
      mime: 'application/json',
      bytes: 10,
    },
    fallback: {
      url: `https://cloud.oxy.so/content/${id}.webp`,
      sha256: 'b'.repeat(64),
      mime: 'image/webp',
      bytes: 10,
    },
  };
}

function transport(handler: (method: string, url: string, data?: unknown) => unknown) {
  const calls: { method: string; url: string; data?: unknown }[] = [];
  const oxy: StickersTransport = {
    request: async <T>(method: string, url: string, data?: unknown) => {
      calls.push({ method, url, data });
      return handler(method, url, data) as T;
    },
  };
  return { oxy, calls };
}

describe('resolve', () => {
  it('asks only for ids it has not seen, and remembers what came back', async () => {
    const { oxy, calls } = transport((_method, _url, data) => ({
      stickers: (data as { ids: string[] }).ids
        .filter((id) => id !== 'unknown')
        .map((id) => sticker(id)),
    }));
    const client = createStickersClient(oxy);

    const first = await client.resolve(['a', 'b', 'a', 'unknown']);
    expect([...first.keys()].sort()).toEqual(['a', 'b']);
    expect(calls).toHaveLength(1);
    expect(calls[0].data).toEqual({ ids: ['a', 'b', 'unknown'] });

    const second = await client.resolve(['a', 'c']);
    expect([...second.keys()].sort()).toEqual(['a', 'c']);
    expect(calls[1].data).toEqual({ ids: ['c'] });
  });

  it('splits more than 100 unseen ids into batches', async () => {
    const { oxy, calls } = transport((_m, _u, data) => ({
      stickers: (data as { ids: string[] }).ids.map((id) => sticker(id)),
    }));
    const ids = Array.from({ length: 250 }, (_, index) => `id-${index}`);
    const result = await createStickersClient(oxy).resolve(ids);
    expect(result.size).toBe(250);
    expect(calls.map((call) => (call.data as { ids: string[] }).ids.length)).toEqual([
      100, 100, 50,
    ]);
  });

  it('answers null for an unknown single sticker', async () => {
    const { oxy } = transport(() => ({ stickers: [] }));
    expect(await createStickersClient(oxy).getSticker('nope')).toBeNull();
  });
});

describe('packs', () => {
  it('turns a 404 into null and seeds the memo from a pack', async () => {
    const { oxy, calls } = transport((_method, url) => {
      if (url.endsWith('/missing')) throw Object.assign(new Error('not found'), { status: 404 });
      if (url.startsWith('/stickers/packs/'))
        return { id: 'p', slug: 'cats', stickers: [sticker('s1')] };
      return { stickers: [] };
    });
    const client = createStickersClient(oxy);
    expect(await client.getPack('missing')).toBeNull();
    await client.getPack('cats');
    expect((await client.getSticker('s1'))?.id).toBe('s1');
    expect(calls.filter((call) => call.url === '/stickers/resolve')).toHaveLength(0);
  });

  it('rethrows anything that is not a 404', async () => {
    const { oxy } = transport(() => {
      throw Object.assign(new Error('boom'), { status: 500 });
    });
    await expect(createStickersClient(oxy).getPack('cats')).rejects.toThrow('boom');
  });

  it('reads a page of the shop from the paginated envelope', async () => {
    const { oxy, calls } = transport(() => ({
      data: [{ id: 'p', cover: sticker('c') }],
      pagination: { total: 30, hasMore: true },
    }));
    const page = await createStickersClient(oxy).listPacks({ offset: 24 });
    expect(page).toMatchObject({ total: 30, hasMore: true });
    expect(calls[0].url).toBe('/stickers/packs?limit=24&offset=24');
  });

  it('builds the reference an app stores', () => {
    const { oxy } = transport(() => ({}));
    expect(createStickersClient(oxy).refOf(sticker('s1'))).toEqual({
      stickerId: 's1',
      packId: 'pack-1',
      sha256: 'a'.repeat(64),
    });
  });
});

describe('verifyStickerBytes', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle)
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  });

  it('accepts the exact bytes and refuses any other', async () => {
    const bytes = new TextEncoder().encode('{"v":"5.7.4"}');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    expect(await verifyStickerBytes({ sha256 }, bytes)).toBe(true);
    expect(await verifyStickerBytes({ sha256 }, new TextEncoder().encode('{"v":"5.7.5"}'))).toBe(
      false,
    );
  });

  it('uses a supplied hasher where WebCrypto is missing', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await verifyStickerBytes({ sha256: 'x' }, bytes, async () => 'x')).toBe(true);
  });
});
