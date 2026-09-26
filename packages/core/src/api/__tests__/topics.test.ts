import { stubbedClient } from './helpers';

describe('oxy.topics', () => {
  it('unwraps categories and search results, defaulting to []', async () => {
    const { oxy, request } = stubbedClient();
    request.mockResolvedValue({ categories: [{ slug: 'a' }] });
    await expect(oxy.topics.categories('es')).resolves.toEqual([{ slug: 'a' }]);
    expect(request).toHaveBeenLastCalledWith('GET', '/topics/categories', { locale: 'es' }, { cache: true, cacheTTL: 1800000 });
    request.mockResolvedValue({});
    await expect(oxy.topics.categories()).resolves.toEqual([]);

    request.mockResolvedValue({ topics: [{ slug: 'b' }] });
    await expect(oxy.topics.search('b', 3)).resolves.toEqual([{ slug: 'b' }]);
    expect(request).toHaveBeenLastCalledWith('GET', '/topics/search', { q: 'b', limit: 3 }, { cache: false });
  });

  it('returns the full list page, falling back to the request', async () => {
    const { oxy, request } = stubbedClient();
    request.mockResolvedValue({ topics: [{ slug: 'x' }, { slug: 'y' }], total: 9, limit: 2, offset: 4 });
    await expect(oxy.topics.list({ limit: 2, offset: 4 })).resolves.toEqual({
      topics: [{ slug: 'x' }, { slug: 'y' }], total: 9, limit: 2, offset: 4,
    });
    request.mockResolvedValue({ topics: [{ slug: 'x' }] });
    await expect(oxy.topics.list({ limit: 5, offset: 1 })).resolves.toEqual({ topics: [{ slug: 'x' }], total: 1, limit: 5, offset: 1 });
    request.mockResolvedValue({});
    await expect(oxy.topics.list()).resolves.toEqual({ topics: [], total: 0, limit: 0, offset: 0 });
  });

  it('flattens the resolved name map', async () => {
    const { oxy, request } = stubbedClient();
    request.mockResolvedValue({ topics: { a: { slug: 'a' }, b: { slug: 'b' } } });
    await expect(oxy.topics.resolveNames([{ name: 'a', type: 't' }])).resolves.toEqual([{ slug: 'a' }, { slug: 'b' }]);
    request.mockResolvedValue({});
    await expect(oxy.topics.resolveNames([])).resolves.toEqual([]);
  });

  it('gets one topic raw, and an update busts its cached read', async () => {
    const { oxy, request } = stubbedClient();
    const bust = jest.spyOn(oxy.cache, 'delete');
    request.mockResolvedValue({ slug: 's' });
    await expect(oxy.topics.get('s')).resolves.toEqual({ slug: 's' });
    await oxy.topics.update('s', { description: 'd' });
    expect(request).toHaveBeenLastCalledWith('PATCH', '/topics/s', { description: 'd' }, { cache: false });
    expect(bust).toHaveBeenCalledWith('GET:/topics/s');
  });
});
