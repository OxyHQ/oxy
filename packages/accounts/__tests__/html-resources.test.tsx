import { renderToStaticMarkup } from 'react-dom/server';
import Root from '../app/+html';

jest.mock('expo-router/html', () => ({
  ScrollViewStyleReset: () => null,
  useServerDocumentContext: () => ({
    htmlAttributes: { dir: 'rtl' },
    bodyAttributes: { 'data-rendered': 'static' },
    headNodes: <link rel="stylesheet" href="/_expo/static/css/app.css" />,
    bodyNodes: <script src="/_expo/static/js/web/app.js" defer />,
  }),
}));

test('preserves Expo hydration assets and document attributes in the static page', () => {
  const html = renderToStaticMarkup(
    <Root>
      <main>Account content</main>
    </Root>,
  );
  expect(html).toContain('dir="rtl"');
  expect(html).toContain('data-rendered="static"');
  expect(html).toMatch(/<head>[\s\S]*href="\/_expo\/static\/css\/app.css"[\s\S]*<\/head>/);
  expect(html).toMatch(
    /<body[^>]*>[\s\S]*Account content[\s\S]*src="\/_expo\/static\/js\/web\/app.js"[\s\S]*<\/body>/,
  );
});
