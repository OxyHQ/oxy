import { parseRichText } from '../rich-text-parse';

describe('parseRichText', () => {
  it('returns plain text as a single run', () => {
    expect(parseRichText('Just words.')).toEqual([{ type: 'text', text: 'Just words.' }]);
  });

  it('splits code, bold and links out of a sentence in order', () => {
    expect(
      parseRichText(
        'Send `oxy_sk_…` as a **token**; see the [guide](/documentation/authentication).',
      ),
    ).toEqual([
      { type: 'text', text: 'Send ' },
      { type: 'code', text: 'oxy_sk_…' },
      { type: 'text', text: ' as a ' },
      { type: 'bold', text: 'token' },
      { type: 'text', text: '; see the ' },
      { type: 'link', text: 'guide', href: '/documentation/authentication' },
      { type: 'text', text: '.' },
    ]);
  });

  it('keeps angle brackets inside a code span verbatim', () => {
    expect(parseRichText('`<publisher>/<model>` is a placeholder')).toEqual([
      { type: 'code', text: '<publisher>/<model>' },
      { type: 'text', text: ' is a placeholder' },
    ]);
  });

  it('leaves unmatched markup as text', () => {
    expect(parseRichText('a `dangling code span')).toEqual([
      { type: 'text', text: 'a `dangling code span' },
    ]);
  });
});
