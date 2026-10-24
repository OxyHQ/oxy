import { renderHook, waitFor } from '@testing-library/react';
import type { OxyServices } from '@oxy.so/core';
import { useFileDownloadUrl } from '../../src/ui/hooks/useFileDownloadUrl';

jest.mock('../../src/ui/context/oxyRuntimeContext', () => ({
  useOptionalOxy: () => ({ user: { id: 'viewer' } }),
}));

function services(cached: Record<string, string>, resolve: (id: string) => Promise<string>) {
  return {
    assets: {
      cachedUrl: (id: string) => cached[id],
      url: jest.fn(resolve),
    },
  } as unknown as OxyServices & { assets: { url: jest.Mock } };
}

describe('useFileDownloadUrl', () => {
  it('answers a cached resolution in the first render and resolves only a miss', async () => {
    const oxy = services({ hit: 'https://cdn/hit' }, async (id) => `https://api/${id}`);

    const hit = renderHook(() => useFileDownloadUrl(oxy, 'hit'));
    expect(hit.result.current).toEqual({ url: 'https://cdn/hit', loading: false, error: null });

    const miss = renderHook(() => useFileDownloadUrl(oxy, 'miss', { variant: 'thumb' }));
    expect(miss.result.current.loading).toBe(true);
    await waitFor(() => expect(miss.result.current.url).toBe('https://api/miss'));
    expect(oxy.assets.url).toHaveBeenCalledTimes(1);
    expect(oxy.assets.url).toHaveBeenCalledWith('miss', 'thumb', undefined);
  });
});
