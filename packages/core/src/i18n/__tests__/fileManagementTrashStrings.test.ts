/**
 * The file manager's trash strings (ADR 0041 D5) exist in EVERY locale, with
 * the same `{{placeholders}}` as English — a missing one would fall back to
 * English mid-screen, a wrong placeholder would print `{{name}}` to a person.
 */
import arSA from '../locales/ar-SA';
import caES from '../locales/ca-ES';
import deDE from '../locales/de-DE';
import enUS from '../locales/en-US';
import esES from '../locales/es-ES';
import frFR from '../locales/fr-FR';
import itIT from '../locales/it-IT';
import jaJP from '../locales/ja-JP';
import koKR from '../locales/ko-KR';
import ptPT from '../locales/pt-PT';
import zhCN from '../locales/zh-CN';

const LOCALES: Record<string, unknown> = {
  'ar-SA': arSA,
  'ca-ES': caES,
  'de-DE': deDE,
  'es-ES': esES,
  'fr-FR': frFR,
  'it-IT': itIT,
  'ja-JP': jaJP,
  'ko-KR': koKR,
  'pt-PT': ptPT,
  'zh-CN': zhCN,
};

/** Every string key the Trash view and the move-to-trash / delete flows read. */
const KEYS = [
  'moveToTrash',
  'moveToTrashCount',
  'deleteFile',
  'confirm',
  'retry',
  'loadError.description',
  'trashView.title',
  'trashView.subtitle',
  'trashView.notice',
  'trashView.emptyTitle',
  'trashView.emptyDescription',
  'trashView.trashedOn',
  'trashView.deleteForever',
  'trashView.loadError',
  'trashView.a11y.restore',
  'trashView.a11y.deleteForever',
  'a11y.moveToTrash',
  'a11y.deleteFile',
  'a11y.openTrash',
  'toasts.movedToTrash',
  'toasts.bulkMovedToTrash',
  'toasts.moveToTrashFailed',
  'toasts.restored',
  'toasts.notInTrash',
  'toasts.restoreFailed',
  'toasts.deletedForever',
  'toasts.deleteSuccess',
  'toasts.deleteFailed',
  'toasts.fileNotFound',
  'toasts.noPermission',
  'toasts.bulkDeleteSuccess',
  'toasts.bulkDeleteFailed',
  'toasts.bulkDeleteError',
  'confirms.deleteFile',
  'confirms.moveToTrash',
  'confirms.moveFilesToTrash',
  'confirms.deleteForever',
  'confirms.deleteForeverInUse',
].map((key) => `fileManagement.${key}`);

function lookup(dict: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      dict,
    );
}

const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

describe('file manager trash strings', () => {
  it.each(KEYS)('English has %s', (key) => {
    expect(typeof lookup(enUS, key)).toBe('string');
  });

  it.each(Object.keys(LOCALES))('%s has every key, with English placeholders', (locale) => {
    for (const key of KEYS) {
      const value = lookup(LOCALES[locale], key);
      expect({ key, type: typeof value }).toEqual({ key, type: 'string' });
      expect({ key, placeholders: placeholders(value as string) }).toEqual({
        key,
        placeholders: placeholders(lookup(enUS, key) as string),
      });
    }
  });
});
