import { act, renderHook, waitFor } from '@testing-library/react';
import { useLanguageManagement } from '../../src/ui/hooks/useLanguageManagement';
import { createMemoryStorage } from '../../src/ui/utils/storageHelpers';

const key = 'test-language';

test('persists multiple guest locales in order and restores the primary on remount', async () => {
  const storage = createMemoryStorage();
  const options = { storage, languageKey: key, user: null };
  const first = renderHook(() => useLanguageManagement(options));
  await act(async () => {
    await first.result.current.setLanguages(['es-ES', 'en-US', 'es-ES']);
  });
  expect(first.result.current.languages).toEqual(['es-ES', 'en-US']);
  expect(first.result.current.currentLanguage).toBe('es-ES');
  first.unmount();
  const second = renderHook(() => useLanguageManagement(options));
  await waitFor(() => expect(second.result.current.languages).toEqual(['es-ES', 'en-US']));
  expect(second.result.current.currentLanguage).toBe('es-ES');
});

test('restores the former single-locale format and can extend it', async () => {
  const storage = createMemoryStorage();
  await storage.setItem(key, 'es-ES');
  const { result } = renderHook(() =>
    useLanguageManagement({ storage, languageKey: key, user: null }),
  );
  await waitFor(() => expect(result.current.languages).toEqual(['es-ES']));
  await act(async () => {
    await result.current.setLanguages([...result.current.languages, 'fr-FR']);
  });
  expect(JSON.parse((await storage.getItem(key)) ?? 'null')).toEqual(['es-ES', 'fr-FR']);
});

test('does not claim an unsaved selection when persistence fails', async () => {
  const storage = createMemoryStorage();
  const logger = jest.fn();
  const { result } = renderHook(() =>
    useLanguageManagement({ storage, languageKey: key, user: null, logger }),
  );
  await act(async () => {
    await result.current.setLanguages(['en-US', 'es-ES']);
  });
  jest.spyOn(storage, 'setItem').mockRejectedValueOnce(new Error('write failed'));
  await act(async () => {
    await expect(result.current.setLanguages(['fr-FR'])).rejects.toThrow('write failed');
  });
  expect(result.current.languages).toEqual(['en-US', 'es-ES']);
});

test('waits for the entry link, gives its supported base locale precedence and persists it', async () => {
  const storage = createMemoryStorage();
  await storage.setItem(key, '["fr-FR"]');
  const screen = renderHook(
    ({ ready, url }) =>
      useLanguageManagement({
        storage,
        languageKey: key,
        user: null,
        entryLinkReady: ready,
        entryUrl: url,
      }),
    { initialProps: { ready: false, url: null as string | null } },
  );
  expect(screen.result.current.isLanguageReady).toBe(false);
  screen.rerender({ ready: true, url: 'https://mention.earth/?lang=es' });
  await waitFor(() => expect(screen.result.current.isLanguageReady).toBe(true));
  expect(screen.result.current.currentLanguage).toBe('es-ES');
  expect(await storage.getItem(key)).toBe('["es-ES"]');
});

test('ignores an unsupported entry language and retains the saved guest preference', async () => {
  const storage = createMemoryStorage();
  await storage.setItem(key, '["fr-FR"]');
  const screen = renderHook(() =>
    useLanguageManagement({
      storage,
      languageKey: key,
      user: null,
      entryUrl: 'mention://compose?lang=zz',
    }),
  );
  await waitFor(() => expect(screen.result.current.isLanguageReady).toBe(true));
  expect(screen.result.current.currentLanguage).toBe('fr-FR');
});

test('migrates the app legacy choice only when the SDK has no saved preference', async () => {
  const storage = createMemoryStorage();
  await storage.setItem('legacy', '"es-ES"');
  const options = { storage, languageKey: key, user: null, legacyLanguageKeys: ['legacy'] };
  const first = renderHook(() => useLanguageManagement(options));
  await waitFor(() => expect(first.result.current.currentLanguage).toBe('es-ES'));
  expect(await storage.getItem('legacy')).toBeNull();
  first.unmount();
  await storage.setItem('legacy', '"fr-FR"');
  const second = renderHook(() => useLanguageManagement(options));
  await waitFor(() => expect(second.result.current.isLanguageReady).toBe(true));
  expect(second.result.current.currentLanguage).toBe('es-ES');
});
