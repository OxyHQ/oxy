/**
 * The audio vocabulary shared by the catalogue and the audio endpoints:
 * language tags, the media types a transcription accepts, and the mapping from
 * a speech request's `response_format` to the media type it produces.
 *
 * New in contract set 4.0.0 (Kaana ADR 0002, decisions 8 and 9).
 */

import { z } from 'zod';
import { type InferenceAudioMediaType, inferenceAudioMediaTypeSchema } from './streamEvents.js';

/**
 * A BCP 47 language tag (`en`, `es-ES`, `zh-Hant-TW`), as voices, models and
 * transcription requests declare languages. Validated by its grammar only: the
 * catalogue is the authority on which tags a model accepts.
 */
export const languageTagSchema = z
  .string()
  .max(35)
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, 'must be a BCP 47 language tag');

/** The formats a speech request names in `response_format`. */
export const speechFormatSchema = z.enum(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']);

/**
 * The media types an uploaded audio file may have
 * (`POST /v1/audio/transcriptions`).
 */
export const audioInputMediaTypeSchema = z.enum([
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/ogg',
  'audio/webm',
  'audio/flac',
  'audio/aac',
  'audio/pcm',
]);

const SPEECH_MEDIA_TYPES = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
} as const satisfies Record<z.infer<typeof speechFormatSchema>, InferenceAudioMediaType>;

/**
 * The media type a speech request's `response_format` produces. A client
 * knows it before the first byte, which is why the speech stream events do
 * not repeat it.
 */
export function speechMediaType(
  format: z.infer<typeof speechFormatSchema>,
): InferenceAudioMediaType {
  return inferenceAudioMediaTypeSchema.parse(SPEECH_MEDIA_TYPES[format]);
}

export type LanguageTag = z.infer<typeof languageTagSchema>;
export type SpeechFormat = z.infer<typeof speechFormatSchema>;
export type AudioInputMediaType = z.infer<typeof audioInputMediaTypeSchema>;
/** The media types speech produces; the contract calls the same set `inferenceAudioMediaTypeSchema`. */
export type AudioMediaType = InferenceAudioMediaType;
