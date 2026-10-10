/**
 * `capabilityAdmits` — the one reader of a model's declared request shapes
 * (contract set 3.2.0, OxyHQ/Kaana#90).
 *
 * Pure, so every arm is asserted directly. The two readings that matter most are
 * the asymmetric ones: an UNDECLARED `apiFormats` keeps the pre-3.2.0 behaviour
 * for an ordinary request, and still refuses a shape that needs a declaration.
 */

import { capabilityAdmits } from '../inferenceCatalogue.service';

const UNDECLARED = { apiFormats: null, realtimeTransports: null, realtimeSessionKinds: null };

describe('capabilityAdmits', () => {
  it('serves an ordinary chat request on a model that declares nothing', () => {
    expect(
      capabilityAdmits(UNDECLARED, {
        input: 'text',
        output: 'text',
        apiFormat: 'chat_completions',
      }),
    ).toBe(true);
  });

  it('refuses spoken output on a model that declares nothing', () => {
    expect(
      capabilityAdmits(UNDECLARED, {
        input: 'text',
        output: 'audio',
        apiFormat: 'chat_completions',
        requiresDeclaredApiFormat: true,
      }),
    ).toBe(false);
  });

  it('serves spoken output on a model that declares the dialect', () => {
    expect(
      capabilityAdmits(
        { ...UNDECLARED, apiFormats: ['chat_completions'] },
        {
          input: 'text',
          output: 'audio',
          apiFormat: 'chat_completions',
          requiresDeclaredApiFormat: true,
        },
      ),
    ).toBe(true);
  });

  it('refuses any dialect a declaring model does not list', () => {
    expect(
      capabilityAdmits(
        { ...UNDECLARED, apiFormats: ['audio_transcriptions'] },
        { input: 'text', output: 'text', apiFormat: 'chat_completions' },
      ),
    ).toBe(false);
  });

  it('never treats a declaration requirement without a dialect as satisfied', () => {
    expect(
      capabilityAdmits(
        { ...UNDECLARED, apiFormats: ['chat_completions'] },
        { input: 'text', output: 'audio', requiresDeclaredApiFormat: true },
      ),
    ).toBe(false);
  });

  it('admits a realtime session only for a declared kind over a declared transport', () => {
    const declared = {
      apiFormats: null,
      realtimeTransports: ['websocket'],
      realtimeSessionKinds: ['conversation'],
    };
    const conversation = {
      input: 'audio' as const,
      output: 'audio' as const,
      realtime: { kind: 'conversation' as const, transport: 'websocket' as const },
    };
    expect(capabilityAdmits(declared, conversation)).toBe(true);
    expect(
      capabilityAdmits(declared, {
        ...conversation,
        realtime: { kind: 'translation', transport: 'websocket' },
      }),
    ).toBe(false);
    // Catalogue presence is not capability evidence: an audio model that holds
    // no declared sessions is refused one.
    expect(capabilityAdmits(UNDECLARED, conversation)).toBe(false);
  });
});
