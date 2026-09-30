/**
 * The DURATION ceiling of a realtime session, and the text items it counts.
 *
 * A route priced by audio milliseconds and per text item (xAI's Voice Agent)
 * is held from the signed byte caps at the signed formats' rates, plus the
 * edge's text-item cap. These cases pin the NUMBER — the one thing the relay
 * suite cannot tell apart from a plausible neighbour — and the one predicate
 * that decides which commands the cap counts, which must agree with the unit
 * Kaana meters (`internal/provider/openairealtime/meter.go`).
 */

import type { RealtimeClientCommand } from '@oxy.so/contracts';
import type { NormalizedEdgeRequest } from '../../schemas/inferenceEdge.schemas';
import {
  REALTIME_AUDIO_BYTES_PER_MS,
  realtimeDurationCeiling,
  routeCeilingPlans,
} from '../inferenceEdge.service';
import { realtimeTextItemBilled } from '../inferenceRealtime.service';

type RealtimeOperation = Extract<NormalizedEdgeRequest['operation'], { kind: 'realtime_session' }>;

function operation(overrides: Partial<RealtimeOperation> = {}): RealtimeOperation {
  return {
    kind: 'realtime_session',
    sessionKind: 'conversation',
    transport: 'websocket',
    maxResponses: 20,
    requiredOutput: 'audio',
    reservationTtlSeconds: 900,
    audio: {
      inputFormat: 'pcm16_24khz',
      outputFormat: 'pcm16_24khz',
      maxInputAudioBytes: 28_800_000,
      maxOutputAudioBytes: 28_800_000,
    },
    maxTextItems: 20,
    ...overrides,
  };
}

function request(op: RealtimeOperation): NormalizedEdgeRequest {
  return {
    operation: op,
    target: { kind: 'model', modelReference: 'x-ai/grok-voice-think-fast-2.0' },
    input: { format: 'text', text: '' },
    stream: true,
    sampling: {},
    tools: [],
  };
}

describe('realtimeDurationCeiling', () => {
  it('is the signed byte caps at the signed formats’ rates, plus the text-item cap', () => {
    // The defaults: ten minutes of PCM16 each way, twenty text items.
    expect(realtimeDurationCeiling(operation())).toEqual({
      audio_input_milliseconds: 600_000,
      audio_output_milliseconds: 600_000,
      requests: 20,
    });
  });

  it('meters G.711 at 8 bytes per ms, six times the milliseconds of the same PCM16 bytes', () => {
    expect(
      realtimeDurationCeiling(
        operation({
          audio: {
            inputFormat: 'g711_alaw',
            outputFormat: 'g711_ulaw',
            maxInputAudioBytes: 480_000,
            maxOutputAudioBytes: 480_000,
          },
        })
      )
    ).toMatchObject({ audio_input_milliseconds: 60_000, audio_output_milliseconds: 60_000 });
  });

  it('holds an unsigned output format at the densest-in-milliseconds format, never PCM16', () => {
    const densest = Math.min(...Object.values(REALTIME_AUDIO_BYTES_PER_MS));
    expect(densest).toBe(8);
    expect(
      realtimeDurationCeiling(
        operation({
          audio: { inputFormat: 'pcm16_24khz', maxInputAudioBytes: 48, maxOutputAudioBytes: 4_800 },
        })
      )
    ).toEqual({ audio_input_milliseconds: 1, audio_output_milliseconds: 600, requests: 20 });
  });

  it('rounds up once, as Kaana rounds the session total', () => {
    expect(
      realtimeDurationCeiling(
        operation({
          audio: {
            inputFormat: 'pcm16_24khz',
            outputFormat: 'pcm16_24khz',
            maxInputAudioBytes: 49,
            maxOutputAudioBytes: 1,
          },
        })
      )
    ).toMatchObject({ audio_input_milliseconds: 2, audio_output_milliseconds: 1 });
  });
});

describe('routeCeilingPlans', () => {
  const route = { maxContextTokens: 32_000, maxOutputTokens: 4_096 };

  it('tries tokens-and-duration, then tokens, then duration, for a realtime session', () => {
    const plans = routeCeilingPlans(request(operation()), route, 10, 0);
    expect(plans.map((plan) => plan.metering)).toEqual(['tokens_and_duration', 'tokens', 'duration']);
    const [both, tokens, duration] = plans;
    expect(duration.scenarios).toEqual([
      { audio_input_milliseconds: 600_000, audio_output_milliseconds: 600_000, requests: 20 },
    ]);
    // Twelve token vertices (4 input × 3 output), each carrying the duration too.
    expect(tokens.scenarios).toHaveLength(12);
    expect(both.scenarios).toHaveLength(12);
    for (const [index, scenario] of both.scenarios.entries()) {
      expect(scenario).toEqual({
        ...tokens.scenarios[index],
        audio_input_milliseconds: 600_000,
        audio_output_milliseconds: 600_000,
        requests: 21,
      });
    }
  });

  it('leaves every one-shot operation with its single token plan', () => {
    const completion: NormalizedEdgeRequest = {
      ...request(operation()),
      operation: { kind: 'completion' },
    };
    expect(routeCeilingPlans(completion, route, 10, 100).map((plan) => plan.metering)).toEqual(['tokens']);
  });
});

describe('realtimeTextItemBilled — what xAI bills as a text input', () => {
  const base = { schemaVersion: 1 as const, requestId: 'req-1', commandId: 'c-1' };
  const item = (value: unknown): RealtimeClientCommand =>
    ({ ...base, type: 'conversation.item.create', item: value }) as RealtimeClientCommand;
  const audio = Buffer.from('audio-bytes').toString('base64');

  it('counts a text message, a system message and a client function call', () => {
    expect(
      realtimeTextItemBilled(item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }))
    ).toBe(true);
    expect(
      realtimeTextItemBilled(item({ type: 'message', role: 'system', content: [{ type: 'input_text', text: 'be brief' }] }))
    ).toBe(true);
    expect(
      realtimeTextItemBilled(item({ type: 'function_call', callId: 'x', name: 'f', arguments: '{}' }))
    ).toBe(true);
  });

  it('does not count a function_call_output or an audio item carrying data', () => {
    expect(realtimeTextItemBilled(item({ type: 'function_call_output', callId: 'x', output: '{}' }))).toBe(false);
    expect(
      realtimeTextItemBilled(
        item({ type: 'message', role: 'user', content: [{ type: 'input_audio', format: 'pcm16_24khz', data: audio }] })
      )
    ).toBe(false);
  });

  it('counts an audio part without data, and a mixed item (Kaana refuses it; counting can only over-hold)', () => {
    expect(
      realtimeTextItemBilled(item({ type: 'message', role: 'user', content: [{ type: 'input_audio', format: 'pcm16_24khz' }] }))
    ).toBe(true);
    expect(
      realtimeTextItemBilled(
        item({
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_audio', format: 'pcm16_24khz', data: audio },
            { type: 'input_text', text: 'and this' },
          ],
        })
      )
    ).toBe(true);
  });

  it('never counts any other command', () => {
    for (const command of [
      { ...base, type: 'response.create' },
      { ...base, type: 'input_audio.append', data: audio },
      { ...base, type: 'input_audio.commit' },
      { ...base, type: 'session.close' },
    ] as RealtimeClientCommand[]) {
      expect(realtimeTextItemBilled(command)).toBe(false);
    }
  });
});
