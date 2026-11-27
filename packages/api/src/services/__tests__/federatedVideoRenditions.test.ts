import { FEDERATION_MEDIA_CACHE_PURPOSE } from '../../constants/federationCache';
import { skipsVideoLadder } from '../federatedVideoRenditions';

const file = (overrides: Partial<Parameters<typeof skipsVideoLadder>[0]> = {}) => ({
  mime: 'video/mp4',
  metadata: {},
  purpose: 'user',
  systemOwner: null,
  ...overrides,
});

describe('skipsVideoLadder', () => {
  it("skips the ladder for Mention's durable copy of a federated video", () => {
    expect(
      skipsVideoLadder(file({ metadata: { source: 'federation', serviceAppId: 'app' } })),
    ).toBe(true);
  });

  it('skips the ladder for a federation media-cache video', () => {
    expect(
      skipsVideoLadder(
        file({
          purpose: FEDERATION_MEDIA_CACHE_PURPOSE,
          systemOwner: '__federation_media_cache__',
        }),
      ),
    ).toBe(true);
  });

  it('keeps the ladder for a video a person uploaded', () => {
    expect(skipsVideoLadder(file())).toBe(false);
    expect(skipsVideoLadder(file({ metadata: { source: 'upload' } }))).toBe(false);
  });

  it('never applies to images, which keep their renditions', () => {
    expect(skipsVideoLadder(file({ mime: 'image/jpeg', metadata: { source: 'federation' } }))).toBe(
      false,
    );
  });
});
