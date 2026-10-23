import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  videoDisplayDimensions,
  videoRungDimensions,
  videoRungs,
  VIDEO_RENDITION_PROFILE,
  type VideoRung,
} from '../video-renditions';
import { VariantService } from '../variantService';
import type { S3Service } from '../s3Service';
import type { FileVisibility, NewFileVariant } from '../../types/file.types';

interface Encoder {
  extractVideoMetadataFromUrl(url: string): Promise<{ width: number; height: number }>;
  generateVideoVariant(
    url: string,
    sha: string,
    rung: VideoRung,
    visibility: FileVisibility,
    profile: string,
  ): Promise<NewFileVariant>;
  generateHLSStream(
    url: string,
    sha: string,
    rungs: VideoRung[],
    visibility: FileVisibility,
    profile: string,
  ): Promise<NewFileVariant[]>;
}

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'oxy-video-test-'));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function probe(file: string) {
  return JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], {
      encoding: 'utf8',
    }),
  ) as { streams: Array<{ width: number; height: number; sample_aspect_ratio: string }> };
}

describe('video display geometry', () => {
  it.each([0, -2, Infinity, NaN])('refuses invalid source width %s', (width) => {
    expect(() => videoDisplayDimensions({ width, height: 90 })).toThrow();
  });
  it('uses display rotation and pixel aspect ratio', () => {
    expect(
      videoDisplayDimensions({ width: 720, height: 576, sample_aspect_ratio: '16:15' }),
    ).toEqual({ width: 768, height: 576 });
    expect(
      videoDisplayDimensions({ width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }),
    ).toEqual({ width: 1080, height: 1920 });
    expect(videoDisplayDimensions({ width: 1920, height: 1080, tags: { rotate: '90' } })).toEqual({
      width: 1080,
      height: 1920,
    });
  });
  it('offers all useful portrait tiers and no duplicate upscaled tiers', () => {
    expect(
      videoRungs({ width: 1080, height: 1920 }).map(({ width, height }) => [width, height]),
    ).toEqual([
      [360, 640],
      [720, 1280],
      [1080, 1920],
    ]);
    expect(videoRungs({ width: 160, height: 90 })).toHaveLength(1);
    expect(videoRungDimensions({ width: 161, height: 91 }, 360)).toEqual({
      width: 160,
      height: 90,
    });
  });
});

it.each([
  { name: 'portrait', width: 180, height: 320, sar: '1', rotation: 0 },
  { name: 'landscape', width: 320, height: 180, sar: '1', rotation: 0 },
  { name: 'square', width: 180, height: 180, sar: '1', rotation: 0 },
  { name: 'odd', width: 161, height: 91, sar: '1', rotation: 0 },
  { name: 'anamorphic', width: 180, height: 180, sar: '2', rotation: 0 },
  { name: 'rotated', width: 320, height: 180, sar: '1', rotation: 90 },
  { name: 'multiple-tiers', width: 400, height: 712, sar: '1', rotation: 0 },
])(
  'encodes $name MP4 and HLS with real dimensions and no added black borders',
  async ({ name, width, height, sar, rotation }) => {
    const source = path.join(directory, `${name}.mp4`);
    // RGB input permits odd dimensions; the actual production output is yuv420p.
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=red:s=${width}x${height}:r=10,format=yuv444p`,
      '-vf',
      `setsar=${sar}`,
      '-t',
      '2.5',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv444p',
      '-y',
      source,
    ]);
    let input = source;
    if (rotation) {
      input = path.join(directory, `${name}-rotated.mp4`);
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-display_rotation:v:0',
        String(rotation),
        '-i',
        source,
        '-c',
        'copy',
        '-y',
        input,
      ]);
    }
    const uploads = new Map<string, Buffer>();
    const store = {
      uploadFile: jest.fn(async (key: string, file: string) => {
        uploads.set(key, await readFile(file));
      }),
      uploadBuffer: jest.fn(async (key: string, data: Buffer) => {
        if (key.endsWith('.m3u8')) {
          for (const uri of data
            .toString()
            .split('\n')
            .filter((line) => line && !line.startsWith('#'))) {
            expect(uploads.has(`${path.dirname(key)}/${uri}`)).toBe(true);
          }
        }
        uploads.set(key, data);
      }),
    } as unknown as S3Service;
    const encoder = new VariantService(store) as unknown as Encoder;
    const dimensions = await encoder.extractVideoMetadataFromUrl(input);
    const rungs = videoRungs(dimensions);
    const rung = rungs[0];
    const display = rotation
      ? { width: height, height: width * Number(sar) }
      : { width: width * Number(sar), height };
    expect(dimensions.width).toBe(display.width);
    expect(dimensions.height).toBe(display.height);
    const profile = `${VIDEO_RENDITION_PROFILE}/${name}`;
    const mp4 = await encoder.generateVideoVariant(input, 'abcd', rung, 'private', profile);
    const hls = await encoder.generateHLSStream(input, 'abcd', rungs, 'private', profile);
    expect(mp4.key).toContain(`/${profile}/`);
    expect(mp4.key).not.toMatch(/^public\//);
    for (const variant of [mp4, ...hls.filter((variant) => variant.type !== 'hls_master')]) {
      const object = uploads.get(variant.key);
      expect(object).toBeDefined();
      const key = variant.type.startsWith('hls_')
        ? [...uploads.keys()].find(
            (key) => key.endsWith('.ts') && key.includes(`segment_${variant.type.slice(4)}_`),
          )
        : variant.key;
      if (!key) throw new Error('No encoded object');
      const bytes = uploads.get(key);
      if (!bytes) throw new Error('No uploaded bytes');
      const filename = path.join(
        directory,
        `${name}-${variant.type}.${key.endsWith('.ts') ? 'ts' : 'mp4'}`,
      );
      await writeFile(filename, bytes);
      const stream = probe(filename).streams[0];
      expect([stream.width, stream.height]).toEqual([variant.width, variant.height]);
      expect(stream.width).toBeLessThanOrEqual(display.width);
      expect(stream.height).toBeLessThanOrEqual(display.height);
      const expectedRatio = display.width / display.height;
      expect(Math.abs(stream.width / stream.height - expectedRatio)).toBeLessThanOrEqual(
        (2 / stream.height) * (1 + expectedRatio),
      );
      expect(stream.sample_aspect_ratio).toBe('1:1');
      const pixel = execFileSync('ffmpeg', [
        '-v',
        'error',
        '-i',
        filename,
        '-vf',
        'format=rgb24,crop=1:1:0:0',
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        'pipe:1',
      ]);
      expect(pixel[0]).toBeGreaterThan(200);
      expect(pixel[1]).toBeLessThan(30);
    }
    const manifest = uploads.get(hls[0].key)?.toString() ?? '';
    expect(manifest).toContain('#EXTINF:2.000000');
    const master = hls.find((variant) => variant.type === 'hls_master');
    expect(master && uploads.get(master.key)?.toString()).toContain(
      `RESOLUTION=${rung.width}x${rung.height}`,
    );
    const timelines = hls
      .filter((variant) => variant.type !== 'hls_master')
      .map((variant) =>
        uploads
          .get(variant.key)
          ?.toString()
          .split('\n')
          .filter((line) => line.startsWith('#EXTINF:')),
      );
    for (const timeline of timelines) expect(timeline).toEqual(timelines[0]);
  },
  30_000,
);
