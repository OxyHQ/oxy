import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectTranslations } from '../src/i18n.mjs';

async function catalog(files) {
  const root = await mkdtemp(join(tmpdir(), 'oxy-i18n-check-'));
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), JSON.stringify(contents));
  }
  return root;
}

const rules = (issues) => issues.map((issue) => `${issue.rule} ${issue.locale} ${issue.key}`);

test('a nested, namespaced catalog passes; plural forms; missing translations only warn', async () => {
  const root = await catalog({
    'app/locales/en.json': {
      compose: { toolbar: { addImage: 'Add image' }, status: { picked_up: 'Picked up' } },
      items: { count_one: 'One item', count_other: '{{count}} items', tips: ['a', 'b'] },
      cart: { items: { one: '%{count} item', other: '%{count} items' } },
    },
    'app/locales/es.json': {
      compose: { toolbar: { addImage: 'Añadir imagen' } },
      items: { count_one: 'Un elemento', count_other: '{{count}} elementos', tips: ['a', 'b'] },
    },
    'app/locales/ru.json': {
      compose: { toolbar: { addImage: 'Добавить' }, status: { picked_up: 'Забран' } },
      items: {
        count_one: 'a',
        count_few: 'b',
        count_many: 'c',
        count_other: '{{count}} шт.',
        tips: ['a'],
      },
      cart: { items: { one: 'a', few: 'b', many: 'c', other: 'd' } },
    },
    'app/locales/ja.json': {
      compose: { toolbar: { addImage: '画像' }, status: { picked_up: '集荷済み' } },
      items: { count_other: '{{count}} 件', tips: ['a'] },
      cart: { items: { other: '%{count} 件' } },
    },
  });

  const [result] = await inspectTranslations(root);

  expect(result.errors).toEqual([]);
  expect(rules(result.warnings)).toEqual([
    'missing-translation es compose.status',
    'missing-translation es cart',
  ]);
});

test('reports text keys, flat keys, top-level strings and stray translations', async () => {
  const root = await catalog({
    'locales/en/common.json': { 'New Post': 'New Post', 'a.b': 'x', ok: 'OK' },
    'locales/fr/common.json': { ok: 'OK', gone: 'Parti' },
    'single/locales/en.json': { Home: 'Home', nav: { home: 'Home' } },
  });

  const [perNamespace, single] = await inspectTranslations(root);

  expect(perNamespace.layout).toBe('per-namespace');
  expect(rules(perNamespace.errors)).toEqual([
    'text-key en common.New Post',
    'flat-key en common.a.b',
    'stray-key fr common.gone',
  ]);
  expect(rules(single.errors)).toEqual(['top-level-string en Home']);
});
