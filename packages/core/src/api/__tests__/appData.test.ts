import { OxyAppDataIdentifierError } from '../appData';
import { stubbedClient } from './helpers';

describe('oxy.appData', () => {
  it('gets a value, null when absent', async () => {
    const { oxy, request } = stubbedClient('me');
    request.mockResolvedValue({ value: { step: 3 } });
    await expect(oxy.appData.get('academy', 'progress')).resolves.toEqual({ step: 3 });
    expect(request).toHaveBeenLastCalledWith('GET', '/users/me/app-data/academy/progress', undefined, { cache: false });
    request.mockResolvedValue({ value: null });
    await expect(oxy.appData.get('academy', 'progress')).resolves.toBeNull();
    request.mockResolvedValue({});
    await expect(oxy.appData.get('academy', 'progress')).resolves.toBeNull();
  });

  it('sets a value and returns what the server stored, else the input', async () => {
    const { oxy, request } = stubbedClient('me');
    request.mockResolvedValue({ value: 2 });
    await expect(oxy.appData.set('ns', 'k', 1)).resolves.toBe(2);
    expect(request).toHaveBeenLastCalledWith('PUT', '/users/me/app-data/ns/k', { value: 1 }, { cache: false });
    request.mockResolvedValue({});
    await expect(oxy.appData.set('ns', 'k', 1)).resolves.toBe(1);
  });

  it('deletes and lists', async () => {
    const { oxy, request } = stubbedClient('me');
    request.mockResolvedValue(undefined);
    await oxy.appData.delete('ns', 'k');
    expect(request).toHaveBeenLastCalledWith('DELETE', '/users/me/app-data/ns/k', undefined, { cache: false });
    request.mockResolvedValue({ entries: { a: 1 } });
    await expect(oxy.appData.list('ns')).resolves.toEqual({ a: 1 });
    request.mockResolvedValue({});
    await expect(oxy.appData.list('ns')).resolves.toEqual({});
  });

  it.each([['', 'k'], ['NS', 'k'], ['ns', 'bad key'], ['x'.repeat(65), 'k']])(
    'rejects %p / %p before any request',
    async (ns, key) => {
      const { oxy, request } = stubbedClient('me');
      await expect(oxy.appData.get(ns, key)).rejects.toBeInstanceOf(OxyAppDataIdentifierError);
      await expect(oxy.appData.set(ns, key, 1)).rejects.toBeInstanceOf(OxyAppDataIdentifierError);
      await expect(oxy.appData.delete(ns, key)).rejects.toBeInstanceOf(OxyAppDataIdentifierError);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('surfaces API errors', async () => {
    const { oxy, request } = stubbedClient('me');
    request.mockRejectedValue(Object.assign(new Error('nope'), { status: 401 }));
    await expect(oxy.appData.get('ns', 'k')).rejects.toThrow('nope');
  });
});
