import { renderHandlePreview } from '../../src/ui/utils/handlePreview';

test('fills {username} and leaves the host origin untouched', () => {
  expect(renderHandlePreview('{base}/@{username}', 'ada')).toBe('{base}/@ada');
  expect(renderHandlePreview('https://example.org/@{username}', 'ada')).toBe(
    'https://example.org/@ada',
  );
  expect(renderHandlePreview('{base}/@{username}', 'ada')).not.toContain('mention.earth');
});

test('previews nothing without a handle or a {username} token', () => {
  expect(renderHandlePreview('{base}/@{username}', '  ')).toBeNull();
  expect(renderHandlePreview('https://example.org/ada', 'ada')).toBeNull();
  expect(renderHandlePreview(null, 'ada')).toBeNull();
});
