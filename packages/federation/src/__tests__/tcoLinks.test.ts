import { createTcoLinkExpander } from '../node/tcoLinks';
import type { SingleHopFetch } from '../node/signedFetch';

const fetchSingleHop: SingleHopFetch = async (url) => {
  const location = { 'https://t.co/abc123': 'https://example.com/', 'https://t.co/self12': url }[
    url
  ];
  return location
    ? new Response(null, { status: 301, headers: { location } })
    : new Response(null, { status: 404 });
};

it('replaces a t.co wrapper with its target and leaves anything else as written', async () => {
  const expand = createTcoLinkExpander({ fetchSingleHop, userAgent: 'test' });

  await expect(
    expand('a https://t.co/abc123 b https://t.co/gone12 c https://t.co/self12 d https://bit.ly/x'),
  ).resolves.toBe(
    'a https://example.com/ b https://t.co/gone12 c https://t.co/self12 d https://bit.ly/x',
  );
});
