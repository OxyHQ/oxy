/**
 * Draws a sticker's static fallback from its animation.
 *
 * Every sticker needs a still image for the surfaces that cannot animate — a
 * push notification, a federated copy of a post, a person who asked for
 * reduced motion — and pack authors ship animations, not stills. So the API
 * renders one.
 *
 * ## The renderer
 *
 * `@lottiefiles/dotlottie-web` is ThorVG compiled to WebAssembly with a
 * SOFTWARE rasterizer: it writes RGBA pixels into its own memory and hands them
 * to a 2D canvas with `putImageData`. That is the whole of what it needs from a
 * browser, so a stand-in canvas whose context captures that one call is enough
 * to run it in Node — no headless browser, no native canvas build.
 *
 * That makes this module depend on the player's internals, which is why the
 * version is PINNED in `package.json` and `stickerRender.test.ts` renders a
 * real animation and asserts the pixels: an upgrade that changes how the
 * player draws fails there, not in production.
 *
 * ## Which frame
 *
 * The first frame of a sticker is often empty (the character pops in), and the
 * last is often mid-exit. The renderer samples frames across the loop and keeps
 * the one with the most visible pixels — the pose where the most of the sticker
 * is on screen — skipping frames that cover nearly the whole canvas, which in
 * practice are transitions rather than the character.
 */

import { readFileSync } from 'node:fs';
import { DotLottie } from '@lottiefiles/dotlottie-web';
import sharp from 'sharp';
import { STICKER_FALLBACK_SIZE } from '@oxy.so/contracts';
import { BadRequestError } from '../utils/error';

/** Frames sampled across the loop when choosing the fallback pose. */
const SAMPLED_FRAMES = 24;
/**
 * A frame covering more of the canvas than this is a transition — a colour
 * wipe, a curtain, a full-bleed flash — not a pose, and is only chosen when
 * every sampled frame is one.
 */
const MAX_POSE_COVERAGE = 0.8;
/** An animation that does not load in this long is refused rather than left holding a request. */
const LOAD_TIMEOUT_MS = 10_000;

let wasmConfigured = false;

/**
 * Points the player at its WebAssembly binary on disk. A `data:` URL rather
 * than a file URL because the player loads it with `fetch`, which in Node reads
 * `data:` natively and does not read `file:`.
 */
function configureWasm(): void {
  if (wasmConfigured) return;
  const wasm = readFileSync(require.resolve('@lottiefiles/dotlottie-web/dotlottie-player.wasm'));
  DotLottie.setWasmUrl(`data:application/wasm;base64,${wasm.toString('base64')}`);
  wasmConfigured = true;
}

/**
 * The player constructs `ImageData` for each frame; Node has no such class.
 * Defined only when absent, and only as the plain container it is.
 */
function ensureImageData(): void {
  if (typeof globalThis.ImageData !== 'undefined') return;
  class NodeImageData {
    constructor(
      public readonly data: Uint8ClampedArray,
      public readonly width: number,
      public readonly height: number,
    ) {}
  }
  Object.defineProperty(globalThis, 'ImageData', {
    value: NodeImageData,
    configurable: true,
    writable: true,
  });
}

interface CapturedFrame {
  pixels: Uint8ClampedArray;
  visible: number;
}

function countVisible(pixels: Uint8ClampedArray): number {
  let visible = 0;
  for (let alpha = 3; alpha < pixels.length; alpha += 4) {
    if (pixels[alpha] !== 0) visible += 1;
  }
  return visible;
}

/** Renders the sticker's fullest pose at `size`, and returns it as a WebP at the fallback size. */
export async function renderStickerFallback(animationJson: Buffer, size: number): Promise<Buffer> {
  configureWasm();
  ensureImageData();

  let latest: Uint8ClampedArray | null = null;
  const context = {
    // The player's buffer is a view into WebAssembly memory that the next
    // frame overwrites, so each frame is copied out as it is drawn.
    putImageData(image: { data: Uint8ClampedArray }): void {
      latest = Uint8ClampedArray.from(image.data);
    },
    clearRect(): void {},
  };
  const canvas = { width: size, height: size, getContext: () => context };

  const player = new DotLottie({
    canvas: canvas as unknown as HTMLCanvasElement,
    data: animationJson.toString('utf8'),
    autoplay: false,
    loop: false,
    renderConfig: { autoResize: false, devicePixelRatio: 1 },
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new BadRequestError('Sticker animation could not be rendered')),
        LOAD_TIMEOUT_MS,
      );
      player.addEventListener('load', () => {
        clearTimeout(timer);
        resolve();
      });
      player.addEventListener('loadError', () => {
        clearTimeout(timer);
        reject(new BadRequestError('Sticker animation could not be rendered'));
      });
    });

    const lastFrame = Math.max(0, player.totalFrames - 1);
    const maxPoseVisible = size * size * MAX_POSE_COVERAGE;
    let bestPose: CapturedFrame | null = null;
    let bestAny: CapturedFrame | null = null;
    for (let sample = 0; sample < SAMPLED_FRAMES; sample += 1) {
      latest = null;
      // `setFrame` draws synchronously, so `latest` holds this frame on return.
      player.setFrame(Math.round((lastFrame * sample) / (SAMPLED_FRAMES - 1)));
      const pixels: Uint8ClampedArray | null = latest;
      if (!pixels) continue;
      const frame = { pixels, visible: countVisible(pixels) };
      if (!bestAny || frame.visible > bestAny.visible) bestAny = frame;
      if (frame.visible <= maxPoseVisible && (!bestPose || frame.visible > bestPose.visible))
        bestPose = frame;
    }
    const best = bestPose ?? bestAny;

    if (!best || best.visible === 0) {
      throw new BadRequestError('Sticker animation renders nothing visible');
    }

    return await sharp(Buffer.from(best.pixels.buffer), {
      raw: { width: size, height: size, channels: 4 },
    })
      .resize(STICKER_FALLBACK_SIZE, STICKER_FALLBACK_SIZE)
      .webp({ quality: 90, alphaQuality: 100 })
      .toBuffer();
  } finally {
    player.destroy();
  }
}
