import { inferenceModalitySchema, inferenceOutputModalitySchema, modelCapabilitiesSchema } from '../inference/catalogue';

it('accepts structured decisions only as declared output, retaining text input', () => {
  expect(inferenceOutputModalitySchema.parse('decisions')).toBe('decisions');
  expect(inferenceModalitySchema.safeParse('decisions').success).toBe(false);
  const base = { inputModalities: ['text'], outputModalities: ['decisions'], apiFormats: ['decisions'],
    tools: false, parallelToolCalls: false, structuredOutput: true, jsonMode: false,
    reasoning: false, streaming: false, promptCaching: false, maxContextTokens: 32768, maxOutputTokens: 8192 };
  expect(modelCapabilitiesSchema.parse(base).outputModalities).toEqual(['decisions']);
  expect(modelCapabilitiesSchema.safeParse({ ...base, inputModalities: ['decisions'] }).success).toBe(false);
  expect(modelCapabilitiesSchema.safeParse({ ...base, outputModalities: ['unknown'] }).success).toBe(false);
  expect(modelCapabilitiesSchema.safeParse({ ...base, outputModalities: [] }).success).toBe(false);
});
