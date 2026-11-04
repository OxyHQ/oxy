import { mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
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
import * as audioRenditions from '../audioRenditions';
import { access } from 'node:fs/promises';
import type { S3Service } from '../s3Service';
import type { FileVisibility, NewFileVariant } from '../../types/file.types';

interface Encoder {
  generatePosterFrame(
    key: string,
    sha: string,
    time: number,
    visibility: FileVisibility,
    metadata: { width: number; height: number },
    profile: string,
    root: undefined,
    local: string,
  ): Promise<NewFileVariant>;
  probeVideoMetadata(url: string): Promise<{ width: number; height: number }>;
  generateVideoVariant(
    url: string,
    sha: string,
    rung: VideoRung,
    visibility: FileVisibility,
    profile: string,
  ): Promise<NewFileVariant>;
  generateVideoRenditions(
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
afterEach(() => {
  jest.restoreAllMocks();
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function probe(file: string) {
  return JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        ...(file.endsWith('.ts') ? ['-f', 'mpegts'] : []),
        '-show_streams',
        '-of',
        'json',
        file,
      ],
      {
        encoding: 'utf8',
      },
    ),
  ) as {
    streams: Array<{
      width: number;
      height: number;
      sample_aspect_ratio: string;
      codec_type: string;
      codec_name: string;
    }>;
  };
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
  { name: 'audio', width: 180, height: 320, sar: '1', rotation: 0, audio: true },
])(
  'encodes $name MP4 and HLS with real dimensions and no added black borders',
  async ({ name, width, height, sar, rotation, audio }) => {
    const run = jest.spyOn(audioRenditions, 'runFfmpeg');
    const source = path.join(directory, `${name}.mp4`);
    // RGB input permits odd dimensions; the actual production output is yuv420p.
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=red:s=${width}x${height}:r=10,format=yuv444p`,
      ...(audio
        ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-c:a', 'aac']
        : []),
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
    const dimensions = await encoder.probeVideoMetadata(input);
    const rungs = videoRungs(dimensions);
    const rung = rungs[0];
    const display = rotation
      ? { width: height, height: width * Number(sar) }
      : { width: width * Number(sar), height };
    expect(dimensions.width).toBe(display.width);
    expect(dimensions.height).toBe(display.height);
    const profile = `${VIDEO_RENDITION_PROFILE}/${name}`;
    const poster = await encoder.generatePosterFrame(
      'original-key',
      'abcd',
      0,
      'private',
      dimensions,
      profile,
      undefined,
      input,
    );
    expect(poster.width).toBeGreaterThan(0);
    expect(poster.height).toBeGreaterThan(0);
    const all = await encoder.generateVideoRenditions(input, 'abcd', rungs, 'private', profile);
    const mp4 = all.find((variant) => variant.type === rung.type);
    if (!mp4) throw new Error('Missing MP4 rendition');
    const hls = all.filter((variant) => variant.type.startsWith('hls_'));
    const encodes = run.mock.calls.filter(([, args]) => args.includes('libx264'));
    const remuxes = run.mock.calls.filter(([, args]) => args.includes('copy'));
    expect(encodes).toHaveLength(rungs.length);
    expect(remuxes).toHaveLength(rungs.length);
    for (let index = 0; index < rungs.length; index++) {
      expect(encodes[index][1]).toEqual(
        expect.arrayContaining(['-protocol_whitelist', 'fd', '-fd', '3', '-i', 'fd:']),
      );
      expect(encodes[index][2].inputFilePath).toBe(input);
      const encodedPath = encodes[index][1].at(-1);
      expect(remuxes[index][1][1]).toBe(encodedPath);
      expect(remuxes[index][1]).not.toContain('-vf');
      expect(encodedPath).toBeDefined();
      await expect(access(String(encodedPath))).rejects.toThrow();
    }

    expect(mp4.key).toContain(`/${profile}/`);
    expect(mp4.key).not.toMatch(/^public\//);
    for (const variant of all.filter((variant) => variant.type !== 'hls_master')) {
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
    // Every segment must start with a keyframe and decode in isolation, including
    // segments after the first. No previous decoder/GOP state is available here.
    for (const [key, bytes] of uploads) {
      if (!key.endsWith('.ts')) continue;
      const segmentFile = path.join(directory, `${name}-${path.basename(key)}`);
      await writeFile(segmentFile, bytes);
      const streams = probe(segmentFile).streams;
      expect(streams.some((stream) => stream.codec_type === 'audio')).toBe(Boolean(audio));
      if (audio)
        expect(streams.find((stream) => stream.codec_type === 'audio')?.codec_name).toBe('aac');
      const frames = JSON.parse(
        execFileSync(
          'ffprobe',
          [
            '-v',
            'error',
            '-f',
            'mpegts',
            '-select_streams',
            'v:0',
            '-show_frames',
            '-show_entries',
            'frame=key_frame',
            '-of',
            'json',
            segmentFile,
          ],
          { encoding: 'utf8' },
        ),
      ).frames;
      expect(frames[0].key_frame).toBe(1);
      expect(frames.length).toBeGreaterThan(0);
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-xerror',
        '-f',
        'mpegts',
        '-i',
        segmentFile,
        '-f',
        'null',
        '-',
      ]);
    }
    // Faststart is a real MP4 property, not merely a command-line option.
    const mp4Bytes = uploads.get(mp4.key);
    expect(mp4Bytes?.indexOf(Buffer.from('moov'))).toBeGreaterThan(0);
    expect(mp4Bytes?.indexOf(Buffer.from('moov'))).toBeLessThan(
      mp4Bytes?.indexOf(Buffer.from('mdat')) ?? 0,
    );
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

async function tinySource(name: string): Promise<string> {
  const source = path.join(directory, `${name}.mp4`);
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=red:s=64x96:r=10',
    '-t',
    '0.4',
    '-c:v',
    'libx264',
    '-y',
    source,
  ]);
  return source;
}

it('keeps lazy MP4 generation independent of HLS and removes its local file after upload', async () => {
  const source = await tinySource('lazy');
  const run = jest.spyOn(audioRenditions, 'runFfmpeg');
  const upload = jest.fn(async (_key: string, filename: string) => {
    expect(probe(filename).streams[0]).toMatchObject({ width: 64, height: 96 });
  });
  const service = new VariantService({
    uploadFile: upload,
  } as unknown as S3Service) as unknown as Encoder;
  const result = await service.generateVideoVariant(
    source,
    'abcd',
    videoRungs({ width: 64, height: 96 })[0],
    'private',
    `${VIDEO_RENDITION_PROFILE}/lazy`,
  );
  expect(result).toMatchObject({ type: '360p', width: 64, height: 96 });
  expect(run).toHaveBeenCalledTimes(1);
  expect(upload).toHaveBeenCalledTimes(1);
  await expect(access(upload.mock.calls[0][1])).rejects.toThrow();
});

it.each(['mp4', 'remux', 'segment', 'playlist'] as const)(
  'cleans the retained MP4 and partial HLS files when %s fails, without publishing a master',
  async (failure) => {
    const source = await tinySource(`failure-${failure}`);
    const actualRun = audioRenditions.runFfmpeg;
    const run = jest
      .spyOn(audioRenditions, 'runFfmpeg')
      .mockImplementation((binary, args, options) => {
        expect(options.timeoutMs).toBe(60 * 60_000);
        if (failure === 'remux' && args.includes('copy'))
          return Promise.resolve({
            code: null,
            signal: 'SIGKILL',
            timedOut: true,
            overflowed: false,
            stderrTail: 'timed out',
          });
        return actualRun(binary, args, options);
      });
    const published: string[] = [];
    const store = {
      uploadFile: jest.fn(async (key: string) => {
        if (
          (failure === 'mp4' && key.endsWith('.mp4')) ||
          (failure === 'segment' && key.endsWith('.ts'))
        )
          throw new Error('upload failed');
        published.push(key);
      }),
      uploadBuffer: jest.fn(async (key: string) => {
        if (failure === 'playlist') throw new Error('upload failed');
        published.push(key);
      }),
    } as unknown as S3Service;
    const encoder = new VariantService(store) as unknown as Encoder;
    await expect(
      encoder.generateVideoRenditions(
        source,
        'abcd',
        videoRungs({ width: 64, height: 96 }),
        'private',
        `${VIDEO_RENDITION_PROFILE}/failure`,
      ),
    ).rejects.toThrow();
    expect(published.some((key) => key.endsWith('hls_master.m3u8'))).toBe(false);
    const encodedPath = String(run.mock.calls[0][1].at(-1));
    await expect(access(path.dirname(encodedPath))).rejects.toThrow();
  },
);

it.each(['file', 'http'])(
  'rejects nested %s reads from an untrusted local container',
  async (protocol) => {
    const source = path.join(directory, `nested-${protocol}.ffconcat`);
    const nestedMedia = path.join(directory, 'nested-target.mp4');
    if (protocol === 'file')
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=red:s=32x64:d=0.1',
        '-y',
        nestedMedia,
      ]);
    const target = protocol === 'file' ? `file:${nestedMedia}` : 'http://127.0.0.1:1/private';
    await writeFile(source, `ffconcat version 1.0\nfile '${target}'\n`);
    const result = await audioRenditions.runFfmpeg(
      'ffprobe',
      ['-v', 'error', '-safe', '0', '-protocol_whitelist', 'fd', '-fd', '3', '-i', 'fd:'],
      { timeoutMs: 2000, inputFilePath: source },
    );
    expect(result.code).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stderrTail).toMatch(/not on whitelist/);
    if (protocol === 'file') {
      // Positive control: the same crafted input reads the local target when
      // the forbidden protocol is admitted. It is not an invalid fixture.
      const allowed = await audioRenditions.runFfmpeg(
        'ffprobe',
        ['-v', 'error', '-safe', '0', '-protocol_whitelist', 'fd,file', '-fd', '3', '-i', 'fd:'],
        { timeoutMs: 2000, inputFilePath: source },
      );
      expect(allowed.code).toBe(0);
    }
  },
);

it('distinguishes a probe process failure from a source with no video stream', async () => {
  const source = path.join(directory, 'invalid-media');
  await writeFile(source, 'not a media container');
  const encoder = new VariantService({} as S3Service) as unknown as Encoder;
  await expect(encoder.probeVideoMetadata(source)).rejects.toThrow('Video probe failed');
  const audio = path.join(directory, 'only-audio.wav');
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1000:duration=0.1',
    '-y',
    audio,
  ]);
  await expect(encoder.probeVideoMetadata(audio)).rejects.toThrow(
    'Source contains no video stream',
  );
});

it('bounds process runtime and diagnostic output without retaining the source descriptor', async () => {
  const source = path.join(directory, 'runner-source');
  await writeFile(source, 'source');
  const timed = await audioRenditions.runFfmpeg(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { timeoutMs: 50, inputFilePath: source },
  );
  expect(timed.timedOut).toBe(true);
  expect(timed.signal).toBe('SIGKILL');
  const output = await audioRenditions.runFfmpeg(
    process.execPath,
    ['-e', "process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000)"],
    { timeoutMs: 2000, maxStdoutBytes: 10, inputFilePath: source },
  );
  expect(output.overflowed).toBe(true);
  expect(output.signal).toBe('SIGKILL');
  const descriptors = await readdir('/proc/self/fd');
  const links = await Promise.all(
    descriptors.map(async (fd: string) => {
      try {
        return await readlink(`/proc/self/fd/${fd}`);
      } catch {
        return undefined;
      }
    }),
  );
  expect(links).not.toContain(source);
});
