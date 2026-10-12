import {
  CONTENT_IMAGE_VARIANTS,
  IMAGE_VARIANTS,
  contentImageSources,
  contentImageVariantForWidth,
  isImageVariantName,
  withImageVariant,
} from '../image';

describe('the ladder', () => {
  it('lists the content rungs smallest first, all width-only', () => {
    const widths = CONTENT_IMAGE_VARIANTS.map((name) => IMAGE_VARIANTS[name].width);
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
    for (const name of CONTENT_IMAGE_VARIANTS) {
      expect(IMAGE_VARIANTS[name]).not.toHaveProperty('height');
    }
  });

  it('knows its own names and nothing else', () => {
    expect(isImageVariantName('w640')).toBe(true);
    expect(isImageVariantName('thumb')).toBe(true);
    expect(isImageVariantName('w641')).toBe(false);
    expect(isImageVariantName('toString')).toBe(false);
    expect(isImageVariantName(undefined)).toBe(false);
  });
});

describe('contentImageVariantForWidth', () => {
  it('picks the smallest rung that covers the physical width', () => {
    expect(contentImageVariantForWidth(1)).toBe('w320');
    expect(contentImageVariantForWidth(320)).toBe('w320');
    expect(contentImageVariantForWidth(321)).toBe('w640');
    expect(contentImageVariantForWidth(1170)).toBe('w1280');
  });

  it('caps at the largest rung rather than asking for more than exists', () => {
    expect(contentImageVariantForWidth(5000)).toBe('w2048');
  });
});

describe('withImageVariant', () => {
  it('sets the variant and keeps the rest of the URL', () => {
    expect(withImageVariant('https://cdn.example/a/b?x=1#frag', 'w640')).toBe(
      'https://cdn.example/a/b?x=1&variant=w640#frag',
    );
  });

  it('replaces a variant already there instead of adding a second one', () => {
    expect(withImageVariant('https://cdn.example/a?variant=w2048', 'w320')).toBe(
      'https://cdn.example/a?variant=w320',
    );
  });

  it('returns a URL it cannot parse unchanged', () => {
    expect(withImageVariant('not a url', 'w320')).toBe('not a url');
  });
});

describe('contentImageSources', () => {
  it('offers one candidate per rung up to the largest asked for', () => {
    expect(contentImageSources('https://cdn.example/img', 'w1280')).toEqual([
      { uri: 'https://cdn.example/img?variant=w320', width: 320 },
      { uri: 'https://cdn.example/img?variant=w640', width: 640 },
      { uri: 'https://cdn.example/img?variant=w1280', width: 1280 },
    ]);
  });

  it('defaults to the whole content ladder', () => {
    expect(contentImageSources('https://cdn.example/img').map((s) => s.width)).toEqual([
      320, 640, 1280, 2048,
    ]);
  });
});
