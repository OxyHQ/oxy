import type { FileRecord, FileVariantRecord } from '../../types/file.types';
import { resolveVideoHlsReadiness } from '../videoHlsReadiness';

const stamp = '2026-10-01T12:34:56.789Z';
function variant(type: string, width?: number, height?: number): FileVariantRecord {
  return {
    id: type,
    fileId: 'video',
    type,
    key: `secret/${type}`,
    width: width ?? null,
    height: height ?? null,
    readyAt: new Date(stamp),
    size: null,
    metadata: null,
  };
}
function legacy(): Pick<FileRecord, 'mime' | 'metadata' | 'variants'> {
  return {
    mime: 'video/mp4',
    metadata: { media: { width: 1080, height: 1920 }, video: { codec: 'h264', audioCodec: 'aac' } },
    variants: [variant('hls_master'), variant('hls_360p', 640, 360)],
  };
}

describe('video HLS readiness', () => {
  it('rejects the exact malformed legacy generation when original playback is known', () => {
    expect(resolveVideoHlsReadiness(legacy())).toEqual({ hlsRejectedReadyAt: stamp });
  });
  it('retains compatible legacy geometry without requiring the new profile', () => {
    const file = legacy();
    file.variants[1] = variant('hls_360p', 360, 640);
    expect(resolveVideoHlsReadiness(file)).toEqual({ hlsReadyAt: stamp });
  });
  it('allows even-pixel rounding on both axes, but detects genuine padding', () => {
    const file = legacy();
    file.metadata = {
      media: { width: 772, height: 1280 },
      video: { codec: 'h264', audioCodec: 'aac' },
    };
    file.variants[1] = variant('hls_360p', 360, 596);
    expect(resolveVideoHlsReadiness(file)).toEqual({ hlsReadyAt: stamp });
    file.variants[1] = variant('hls_360p', 360, 640);
    expect(resolveVideoHlsReadiness(file)).toEqual({ hlsRejectedReadyAt: stamp });
  });
  it.each([
    [1920, 1080, false],
    [1440, 1080, true],
    [1000, 1000, true],
  ])(
    'checks source %sx%s without assuming all legacy landscape ladders are wrong',
    (width, height, rejected) => {
      const file = legacy();
      file.metadata = { media: { width, height }, video: { codec: 'h264', audioCodec: 'aac' } };
      expect(resolveVideoHlsReadiness(file)).toEqual(
        rejected ? { hlsRejectedReadyAt: stamp } : { hlsReadyAt: stamp },
      );
    },
  );
  it('checks every ready tier, without treating posters or unfinished tiers as HLS evidence', () => {
    const file = legacy();
    file.variants[1] = variant('hls_360p', 360, 640);
    file.variants.push(variant('poster', 640, 360), {
      ...variant('hls_720p', 1280, 720),
      readyAt: null,
    });
    expect(resolveVideoHlsReadiness(file)).toEqual({ hlsReadyAt: stamp });
    file.variants.push(variant('hls_1080p', 1920, 1080));
    expect(resolveVideoHlsReadiness(file)).toEqual({ hlsRejectedReadyAt: stamp });
  });
  it('never rejects a completed current-profile generation', () => {
    const file = legacy();
    file.variants[0].metadata = { encodingProfile: 'video-v2' };
    expect(resolveVideoHlsReadiness(file)).toEqual({ hlsReadyAt: stamp });
  });
  it.each(['video/webm', 'video/quicktime', 'video/x-matroska', 'audio/mp4'])(
    'retains %s originals',
    (mime) => {
      expect(resolveVideoHlsReadiness({ ...legacy(), mime })).toEqual({ hlsReadyAt: stamp });
    },
  );
  it.each([undefined, 'vp9', 'av1', 'hevc'])('retains unknown or non-H264 codec %s', (codec) => {
    const file = legacy();
    file.metadata = { media: { width: 1080, height: 1920 }, video: { codec, audioCodec: 'aac' } };
    expect(resolveVideoHlsReadiness(file)).toEqual({ hlsReadyAt: stamp });
  });
  it.each([undefined, null, 'opus', 'mp3', ''])(
    'retains unknown or non-AAC audio %s',
    (audioCodec) => {
      const file = legacy();
      file.metadata = {
        media: { width: 1080, height: 1920 },
        video: { codec: 'h264', audioCodec },
      };
      expect(resolveVideoHlsReadiness(file)).toEqual({ hlsReadyAt: stamp });
    },
  );
  it('accepts a known H264/AAC M4V and uses original dimensions when canonical fields are absent', () => {
    const file = legacy();
    file.mime = 'video/x-m4v';
    file.metadata = { video: { codec: 'h264', audioCodec: 'aac', width: 1080, height: 1920 } };
    expect(resolveVideoHlsReadiness(file)).toEqual({ hlsRejectedReadyAt: stamp });
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, '1080', undefined])(
    'does not infer mismatch from invalid original width %s',
    (width) => {
      const file = legacy();
      file.metadata = {
        media: { width, height: 1920 },
        video: { codec: 'h264', audioCodec: 'aac' },
      };
      expect(resolveVideoHlsReadiness(file)).toEqual({ hlsReadyAt: stamp });
    },
  );
  it('does not use rendition dimensions as a substitute for missing original dimensions', () => {
    const file = legacy();
    file.metadata = { video: { codec: 'h264', audioCodec: 'aac' } };
    file.variants.push(variant('poster', 1080, 1920));
    expect(resolveVideoHlsReadiness(file)).toEqual({ hlsReadyAt: stamp });
  });
  it('retains a ladder when no ready rung has usable dimensions', () => {
    const file = legacy();
    file.variants[1] = variant('hls_360p', 0, Number.POSITIVE_INFINITY);
    expect(resolveVideoHlsReadiness(file)).toEqual({ hlsReadyAt: stamp });
  });
  it('does not confuse absent or unfinished masters with a rejected generation', () => {
    const file = legacy();
    file.variants[0].readyAt = null;
    expect(resolveVideoHlsReadiness(file)).toEqual({});
    file.variants = [];
    expect(resolveVideoHlsReadiness(file)).toEqual({});
  });
});
