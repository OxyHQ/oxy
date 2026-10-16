/**
 * The pure halves of the audio rendition pipeline (ADR 0043 stage 4c,
 * `audioRenditions.ts`): which rungs a source gets, the preview window, the
 * waveform accumulator's bounded memory, the measured bandwidth.
 */

import {
  audioMasterPlaylist,
  audioProfileOf,
  measureBandwidth,
  previewWindow,
  sameAudioProfile,
  selectAudioRungs,
  WaveformAccumulator,
} from '../audioRenditions';

const types = (probe: Parameters<typeof selectAudioRungs>[0]) =>
  selectAudioRungs(probe).map((rung) => rung.type);

describe('selectAudioRungs', () => {
  it('always makes the 64 kb/s rung, and no rung a lossy source cannot fill', () => {
    expect(types({ codec: 'mp3', bitrate: 64_000 })).toEqual(['hls_a64']);
    expect(types({ codec: 'mp3', bitrate: 96_000 })).toEqual(['hls_a64', 'hls_a128']);
    expect(types({ codec: 'mp3', bitrate: 191_999 })).toEqual(['hls_a64', 'hls_a128']);
    expect(types({ codec: 'mp3', bitrate: 320_000 })).toEqual(['hls_a64', 'hls_a128', 'hls_a256']);
    expect(types({ codec: 'opus', bitrate: 32_000 })).toEqual(['hls_a64']);
  });

  it('makes every rung for a lossless source or an unknown bitrate', () => {
    expect(types({ codec: 'flac', bitrate: 50_000 })).toHaveLength(3);
    expect(types({ codec: 'pcm_s16le' })).toHaveLength(3);
    expect(types({ codec: 'aac' })).toHaveLength(3);
  });
});

describe('previewWindow', () => {
  it('clamps the start so a whole 30 s fits, and previews a short file whole', () => {
    expect(previewWindow(100, 0)).toEqual({
      startSeconds: 0,
      durationSeconds: 30,
      truncated: true,
    });
    expect(previewWindow(100, 90)).toEqual({
      startSeconds: 70,
      durationSeconds: 30,
      truncated: false,
    });
    expect(previewWindow(12, 5)).toEqual({
      startSeconds: 0,
      durationSeconds: 12,
      truncated: false,
    });
    expect(previewWindow(100, -3).startSeconds).toBe(0);
  });
});

describe('audioProfileOf', () => {
  it('reads only the server-owned options, and compares them', () => {
    const plain = audioProfileOf({ metadata: {} });
    const normalized = audioProfileOf({ metadata: { audioOptions: { normalizeLoudness: true } } });
    const truthy = audioProfileOf({ metadata: { audioOptions: { normalizeLoudness: 'yes' } } });
    expect(plain).toEqual({ normalizeLoudness: false, previewStartSeconds: 0 });
    expect(normalized.normalizeLoudness).toBe(true);
    expect(truthy.normalizeLoudness).toBe(false);
    expect(sameAudioProfile(plain, truthy)).toBe(true);
    expect(sameAudioProfile(plain, normalized)).toBe(false);
  });
});

describe('WaveformAccumulator', () => {
  function pcm(samples: number[]): Buffer {
    const buffer = Buffer.alloc(samples.length * 2);
    for (const [index, sample] of samples.entries()) buffer.writeInt16LE(sample, index * 2);
    return buffer;
  }

  it('sizes buckets from the duration and scales to int8', () => {
    const accumulator = new WaveformAccumulator(1); // 8000 samples → 4 per peak
    accumulator.push(pcm(Array.from({ length: 8000 }, (_, i) => (i % 4 === 0 ? 32767 : -32768))));
    const waveform = accumulator.finish();
    expect(waveform.samplesPerPeak).toBe(4);
    expect(waveform.length).toBe(2000);
    expect(waveform.data.slice(0, 4)).toEqual([-128, 127, -128, 127]);
  });

  it('carries an odd byte across chunks', () => {
    const accumulator = new WaveformAccumulator(1);
    const bytes = pcm([1000, -2000, 3000, -4000]);
    accumulator.push(bytes.subarray(0, 3));
    accumulator.push(bytes.subarray(3));
    expect(accumulator.finish().data).toEqual([Math.round(-4000 / 256), Math.round(3000 / 256)]);
  });

  it('keeps memory bounded when the duration is unknown', () => {
    const accumulator = new WaveformAccumulator(undefined);
    const chunk = pcm(new Array(64 * 1000).fill(100));
    for (let i = 0; i < 20; i++) accumulator.push(chunk);
    const waveform = accumulator.finish();
    expect(waveform.length).toBeLessThan(4000);
    expect(waveform.length * waveform.samplesPerPeak).toBeGreaterThanOrEqual(20 * 64 * 1000);
  });
});

describe('measureBandwidth and the master playlist', () => {
  it('reports the peak and the average from the segments, else the nominal rate plus overhead', () => {
    expect(
      measureBandwidth(
        [
          { duration: 6, bytes: 60_000 },
          { duration: 6, bytes: 120_000 },
        ],
        128_000,
      ),
    ).toEqual({ peak: 160_000, average: 120_000 });
    expect(measureBandwidth([], 64_000)).toEqual({ peak: 73_600, average: 73_600 });
  });

  it('names renditions by basename with the AAC codec and no resolution', () => {
    const master = audioMasterPlaylist([
      {
        playlistKey: 'public/variants/2026/10/ab/sha/ln/hls_a64.m3u8',
        bandwidth: 70_000,
        averageBandwidth: 66_000,
      },
    ]);
    expect(master).toContain(
      '#EXT-X-STREAM-INF:BANDWIDTH=70000,AVERAGE-BANDWIDTH=66000,CODECS="mp4a.40.2"\nhls_a64.m3u8\n',
    );
    expect(master).not.toContain('RESOLUTION');
  });
});
