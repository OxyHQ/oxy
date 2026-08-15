/**
 * The inference catalogue client — what it puts on the wire.
 *
 * There is exactly one piece of real logic in this mixin, and it is
 * `getInferenceModel`'s URL: a canonical model id CONTAINS a slash, so it has to
 * become TWO path segments rather than one encoded one. Everything else is a
 * pass-through, so these cases pin the part that can actually be wrong rather
 * than restating the method bodies.
 *
 * Every refusal block is paired with a positive control proving a valid input
 * DOES reach the transport — without it, a method that threw unconditionally
 * would satisfy every "it sends nothing" assertion.
 *
 * Driven through a real `OxyServices` with `makeRequest` spied, like
 * `accounts.test.ts`, rather than a hand-rolled fake base: a fake is not
 * assignable to the mixin's `typeof OxyServicesBase` bound and would need casts
 * to compile.
 */

import { OxyServices } from '../../OxyServices';

describe('OxyServices inference catalogue', () => {
  let oxy: OxyServices;
  let makeRequestSpy: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeRequestSpy = jest.spyOn(oxy, 'makeRequest');
  });

  afterEach(() => {
    makeRequestSpy.mockRestore();
  });

  describe('listInferenceModels', () => {
    it('GETs /models and unwraps the data envelope', async () => {
      const entry = { schemaVersion: 1, modelId: 'openai/gpt-5' };
      makeRequestSpy.mockResolvedValue({ data: [entry], count: 1 });

      await expect(oxy.listInferenceModels()).resolves.toEqual([entry]);
      expect(makeRequestSpy).toHaveBeenCalledWith('GET', '/models');
    });

    it('returns an empty array for an empty catalogue rather than throwing', async () => {
      // The catalogue IS empty today: no route has an approved commercial
      // permission yet. A consumer treating `[]` as a failure would be broken on
      // the only response the endpoint currently produces.
      makeRequestSpy.mockResolvedValue({ data: [], count: 0 });

      await expect(oxy.listInferenceModels()).resolves.toEqual([]);
    });
  });

  describe('getInferenceModel', () => {
    it('splits the canonical id into two path segments', async () => {
      const entry = { schemaVersion: 1, modelId: 'openai/gpt-5' };
      makeRequestSpy.mockResolvedValue({ data: entry });

      await expect(oxy.getInferenceModel('openai/gpt-5')).resolves.toEqual(entry);
      // NOT `/models/openai%2Fgpt-5` — a single encoded segment matches no route.
      expect(makeRequestSpy).toHaveBeenCalledWith('GET', '/models/openai/gpt-5');
    });

    it('refuses a revision-pinned reference, and sends nothing', async () => {
      // `<publisher>/<model>@<revision>` names a model REFERENCE, not a model.
      // Sent as-is it would 404 indistinguishably from "no such model".
      await expect(oxy.getInferenceModel('openai/gpt-5@2026-05-01')).rejects.toThrow(
        'Not a canonical model id',
      );
      expect(makeRequestSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['no publisher segment', 'gpt-5'],
      ['a third segment', 'openai/gpt-5/turbo'],
      ['an empty publisher', '/gpt-5'],
      ['an empty model', 'openai/'],
      ['uppercase, which the id grammar forbids', 'OpenAI/GPT-5'],
      ['the empty string', ''],
    ])('refuses %s, and sends nothing', async (_label, modelId) => {
      await expect(oxy.getInferenceModel(modelId)).rejects.toThrow('Not a canonical model id');
      expect(makeRequestSpy).not.toHaveBeenCalled();
    });

    it('positive control: a well-formed id DOES reach the transport', async () => {
      // Without this, a method that threw unconditionally would satisfy every
      // "sends nothing" assertion above.
      makeRequestSpy.mockResolvedValue({ data: { schemaVersion: 1, modelId: 'meta/llama-3.1-70b' } });

      await oxy.getInferenceModel('meta/llama-3.1-70b');
      expect(makeRequestSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('listInferenceRoutingProfiles', () => {
    it('GETs the routing-profiles collection, not a publisher/model pair', async () => {
      // `routing-profiles` is ONE segment. Were it ever built as two, it would be
      // captured by `/models/:publisher/:model` and read as a model lookup.
      const profile = { schemaVersion: 1, slug: 'auto' };
      makeRequestSpy.mockResolvedValue({ data: [profile], count: 1 });

      await expect(oxy.listInferenceRoutingProfiles()).resolves.toEqual([profile]);
      expect(makeRequestSpy).toHaveBeenCalledWith('GET', '/models/routing-profiles');
    });
  });
});
