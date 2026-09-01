import { jsonObjectSchemaToZod } from '../jsonSchema';

const schema = jsonObjectSchemaToZod({
  type: 'object',
  properties: {
    kind: { const: 'mention' },
    visibility: { enum: ['public', 'private'] },
    destination: {
      anyOf: [
        { type: 'string', format: 'email' },
        { type: 'string', format: 'uri' },
      ],
    },
    payload: {
      oneOf: [
        {
          type: 'object',
          properties: { text: { type: 'string', minLength: 1 } },
          required: ['text'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { mediaUrl: { type: 'string', format: 'uri' } },
          required: ['mediaUrl'],
          additionalProperties: false,
        },
      ],
    },
    score: { type: 'number', minimum: 0, exclusiveMaximum: 10 },
    sequence: { type: 'integer', exclusiveMinimum: 0, maximum: 20 },
    tags: {
      type: 'array',
      items: { type: 'string', pattern: '^[a-z-]+$' },
      minItems: 1,
      maxItems: 2,
    },
    publishedAt: { type: 'string', format: 'date-time' },
  },
  required: [
    'kind',
    'visibility',
    'destination',
    'payload',
    'score',
    'sequence',
    'tags',
    'publishedAt',
  ],
  additionalProperties: false,
});

const valid = {
  kind: 'mention',
  visibility: 'public',
  destination: 'person@example.com',
  payload: { text: 'Hello' },
  score: 9.5,
  sequence: 1,
  tags: ['release-note'],
  publishedAt: '2026-09-01T10:00:00Z',
};

describe('JSON Schema conversion', () => {
  it('preserves Mention schema composition, formats and bounds', () => {
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, kind: 'post' }).success).toBe(false);
    expect(schema.safeParse({ ...valid, visibility: 'followers' }).success).toBe(false);
    expect(schema.safeParse({ ...valid, destination: 'not an address' }).success).toBe(false);
    expect(schema.safeParse({ ...valid, payload: {} }).success).toBe(false);
    expect(schema.safeParse({ ...valid, score: 10 }).success).toBe(false);
    expect(schema.safeParse({ ...valid, sequence: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...valid, tags: [] }).success).toBe(false);
    expect(schema.safeParse({ ...valid, tags: ['one', 'two', 'three'] }).success).toBe(false);
    expect(schema.safeParse({ ...valid, tags: ['UPPER'] }).success).toBe(false);
    expect(schema.safeParse({ ...valid, publishedAt: 'yesterday' }).success).toBe(false);
    expect(schema.safeParse({ ...valid, unexpected: true }).success).toBe(false);
  });
});
