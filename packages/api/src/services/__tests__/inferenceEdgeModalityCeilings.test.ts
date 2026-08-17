/**
 * The per-modality reservation CEILINGS — the arithmetic a hold is sized from.
 *
 * ## Why this file exists separately from the route tests
 *
 * A hold is the one thing on the edge that costs money when it is wrong, and it is
 * wrong in a way no functional test notices: an under-sized ceiling serves the
 * request, returns a correct answer, and settles above its own hold. The route
 * tests prove a request is admitted, gated and limited. This file proves the
 * NUMBER, and it is the only place that does.
 *
 * ## The property being asserted, per arm
 *
 * A ceiling must be a PROVABLE UPPER BOUND on what the request can consume, per
 * priced unit, derivable from the request body before execution. Two arms are
 * exact (`characters`, `images` — the caller declared them) and `input_tokens` is
 * bounded by characters on the one argument that generalises: every BPE token
 * consumes at least one character of its input.
 *
 * ## What is NOT asserted here, deliberately
 *
 * Whether the route prices these units. That is `quoteUnits`' job, and the
 * omissions below are what make it work: `speech` carries no
 * `audio_output_milliseconds`, so a duration-priced route fails to quote and is
 * refused — the refusal is arithmetic rather than a branch, and asserting it here
 * would be asserting `quoteUnits`.
 */

import {
  ceilingForOperation,
  estimateInputTokens,
  modalityForOperation,
} from '../inferenceEdge.service';
import {
  imageGenerationsRequestSchema,
  normalizeImageGenerationsRequest,
  normalizeSpeechRequest,
  speechRequestSchema,
} from '../../schemas/inferenceEdge.schemas';

/** The ceiling as the admission path computes it, from a real parsed body. */
function speechCeiling(body: unknown): Partial<Record<string, number>> {
  const parsed = speechRequestSchema.parse(body);
  const normalized = normalizeSpeechRequest(parsed);
  return ceilingForOperation(normalized.operation, estimateInputTokens(normalized), 0);
}

function imagesCeiling(body: unknown): Partial<Record<string, number>> {
  const parsed = imageGenerationsRequestSchema.parse(body);
  const normalized = normalizeImageGenerationsRequest(parsed);
  return ceilingForOperation(normalized.operation, estimateInputTokens(normalized), 0);
}

describe('POST /v1/audio/speech — the characters ceiling', () => {
  it('holds EXACTLY the characters of the string the provider will receive', () => {
    // The disagreement case. `input.length` is 9 — two leading spaces, two
    // trailing, and an accented character. An implementation that trimmed, or that
    // counted "words", or that used the token estimate, would produce 5, 1 or ~11
    // and every one of those is a different number from the one the provider bills.
    const ceiling = speechCeiling({ model: 'pub/mdl', input: '  héllo  ', voice: 'alloy' });

    expect(ceiling.characters).toBe(9);
  });

  it('carries NO duration unit — the omission is the soundness argument', () => {
    // Output duration is characters ÷ speaking rate, and no route field declares a
    // speaking rate. Any number here would be a guess, and a guessed hold is how a
    // balance goes negative. The consequence is intended: a duration-priced route
    // fails to quote and is refused.
    const ceiling = speechCeiling({
      model: 'pub/mdl',
      input: 'a'.repeat(500),
      voice: 'alloy',
      speed: 0.25,
    });

    expect(ceiling.audio_output_milliseconds).toBeUndefined();
    expect(ceiling.audio_input_milliseconds).toBeUndefined();
  });

  it('does not vary with `speed` or `voice`, which is why it stays exact', () => {
    const slow = speechCeiling({ model: 'pub/mdl', input: 'hello', voice: 'a', speed: 0.25 });
    const fast = speechCeiling({ model: 'pub/mdl', input: 'hello', voice: 'zzz', speed: 4 });

    // Same text, same hold. If either parameter moved the number, the ceiling
    // would depend on a rate nothing declares.
    expect(slow).toEqual(fast);
  });

  it('holds no output tokens — an audio clip is not a token stream', () => {
    const ceiling = speechCeiling({ model: 'pub/mdl', input: 'hello', voice: 'alloy' });

    // Omitted rather than zero: `quoteUnits` refuses a unit the route does not
    // price, so a zero would make every sensibly-priced TTS route fail to quote.
    expect(ceiling.output_tokens).toBeUndefined();
  });

  it('needs a route that accepts text and produces audio', () => {
    const parsed = speechRequestSchema.parse({ model: 'pub/mdl', input: 'x', voice: 'alloy' });
    expect(modalityForOperation(normalizeSpeechRequest(parsed).operation)).toEqual({
      input: 'text',
      output: 'audio',
    });
  });
});

describe('POST /v1/images/generations — the images ceiling', () => {
  it('holds EXACTLY `n` images, independent of the prompt', () => {
    // The disagreement case for this endpoint: the declared count (10) and the
    // prompt's character count (3) point at completely different numbers. The hold
    // must follow the declared count, because that is what bounds what the
    // provider can return.
    const ceiling = imagesCeiling({ model: 'pub/mdl', prompt: 'cat', n: 10 });

    expect(ceiling.images).toBe(10);
  });

  it('defaults to one image when the caller names none', () => {
    const ceiling = imagesCeiling({ model: 'pub/mdl', prompt: 'cat' });

    expect(ceiling.images).toBe(1);
  });

  it('a long prompt does NOT inflate the image count', () => {
    const ceiling = imagesCeiling({ model: 'pub/mdl', prompt: 'x'.repeat(5_000), n: 1 });

    expect(ceiling.images).toBe(1);
    // ...but it does raise the token bound, because the prompt is still billed.
    expect(ceiling.input_tokens).toBeGreaterThan(5_000);
  });

  it('does not vary with `size`, `quality` or `style`', () => {
    // These are forwarded and priced by being SEPARATE ROUTES in the catalogue, not
    // by widening the hold — a price version prices a unit, not a
    // `(unit, size, quality)` tuple. If this ever diverges, the hold has started
    // guessing at a price class.
    const cheap = imagesCeiling({ model: 'pub/mdl', prompt: 'cat', n: 2, size: '256x256' });
    const dear = imagesCeiling({
      model: 'pub/mdl',
      prompt: 'cat',
      n: 2,
      size: '1792x1024',
      quality: 'hd',
      style: 'vivid',
    });

    expect(cheap).toEqual(dear);
  });

  it('holds no output tokens — an image is not a token stream', () => {
    expect(imagesCeiling({ model: 'pub/mdl', prompt: 'cat' }).output_tokens).toBeUndefined();
  });

  it('needs a route that accepts text and produces images', () => {
    const parsed = imageGenerationsRequestSchema.parse({ model: 'pub/mdl', prompt: 'cat' });
    expect(modalityForOperation(normalizeImageGenerationsRequest(parsed).operation)).toEqual({
      input: 'text',
      output: 'image',
    });
  });
});

describe('the arms with no route yet', () => {
  /**
   * `embeddings` and `rerank` are members of `EdgeOperation` and have sound
   * ceilings, but no endpoint: `inferenceContentPartSchema` is
   * `text | image | audio | file | refusal`, so neither a vector nor a ranking can
   * be RETURNED. Their arithmetic is asserted anyway, so that whoever adds the
   * output shape inherits a bound that was reviewed rather than one written under
   * delivery pressure.
   */
  it('bounds embeddings by the declared input count and the character total', () => {
    expect(ceilingForOperation({ kind: 'embeddings', embeddings: 3 }, 120, 0)).toEqual({
      input_tokens: 120,
      embeddings: 3,
    });
  });

  it('bounds rerank by characters alone, with no `requests` unit', () => {
    // `requests` is omitted on purpose: a route priced only on tokens is the common
    // case, and adding a unit the route does not price would make `quoteUnits`
    // refuse it — turning a pricing convention into an outage.
    expect(ceilingForOperation({ kind: 'rerank' }, 400, 0)).toEqual({ input_tokens: 400 });
  });

  it('constrains rerank on INPUT only, because no modality expresses a ranking', () => {
    expect(modalityForOperation({ kind: 'rerank' })).toEqual({ input: 'text' });
  });

  it('constrains embeddings to a route that produces embeddings', () => {
    expect(modalityForOperation({ kind: 'embeddings', embeddings: 1 })).toEqual({
      input: 'text',
      output: 'embedding',
    });
  });
});

describe('completions are unchanged by the modality work', () => {
  it('still holds input and output tokens, and nothing else', () => {
    // The regression guard. Every arm above is additive, and a change to the
    // completion ceiling would move the number for the endpoint that actually
    // serves traffic.
    expect(ceilingForOperation({ kind: 'completion' }, 1_000, 4_096)).toEqual({
      input_tokens: 1_000,
      output_tokens: 4_096,
    });
  });

  it('still requires a text-in, text-out route', () => {
    expect(modalityForOperation({ kind: 'completion' })).toEqual({
      input: 'text',
      output: 'text',
    });
  });
});
