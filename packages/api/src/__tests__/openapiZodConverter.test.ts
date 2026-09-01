import { z } from 'zod';
import {
  inferenceContentPartSchema,
  inferenceInputSchema,
  oxyAccountIdSchema,
  responseFormatSchema,
  routingTargetSchema,
} from '@oxyhq/contracts';
import { chatCompletionsRequestSchema } from '../schemas/inferenceEdge.schemas';
import { zodToOpenApi } from '../../scripts/generate-openapi';

/**
 * `zodToOpenApi` decides what the PUBLISHED contract says every request body and
 * every described response looks like, and each case below exists because the
 * converter used to be silently wrong about one — wrong in the direction that
 * produces a valid-looking document rather than an error.
 *
 * 1. **A discriminated union converted to `{}`.** There was no
 *    `ZodDiscriminatedUnion` case, so eleven of them fell through the `default`
 *    arm. `{}` is valid OpenAPI and it means ANY VALUE IS ACCEPTABLE, which is
 *    indistinguishable from a deliberate `z.unknown()` — so the contract said a
 *    chat message's content array accepts anything at all, and a generated client
 *    typed it `Any`.
 *
 * 2. **Only the LAST `min`/`max` check survived.** `.positive().safe()` emits two
 *    `min` checks and the loop overwrote on each, publishing the loosest.
 *    `policyVersion` on
 *    `GET /inference/routing-policies/{policyId}/versions/{policyVersion}` was
 *    published as accepting -9007199254740991.
 *
 * 3. **OpenAPI 3.0 spellings in a 3.1 document.** `openapi.base.yaml` declares
 *    3.1.0, where `nullable` does not exist and `exclusiveMinimum` carries the
 *    bound instead of being a boolean beside `minimum`. Both were emitted in the
 *    3.0 form, which a conforming consumer drops in silence — so a nullable field
 *    was published as non-nullable.
 *
 * The fixtures are the REAL schemas from `@oxyhq/contracts` and from the edge,
 * not tidy stand-ins: the defect lived in the shapes the API actually publishes,
 * and a hand-made two-branch union would have been converted correctly by a
 * narrower fix. Every case is paired with an assertion that the converter still
 * produces the ordinary answer, because a test that only asserted the absence of
 * `{}` would pass against a converter that emitted `{}` nowhere and nonsense
 * everywhere.
 */
describe('zodToOpenApi: discriminated unions', () => {
  it('converts a real contracts discriminated union to oneOf, not to an empty schema', () => {
    const converted = zodToOpenApi(inferenceContentPartSchema);

    // The pre-fix output, stated exactly, so this test fails if the case is removed.
    expect(converted).not.toEqual({});
    expect(converted.discriminator).toEqual({ propertyName: 'type' });
    expect(Array.isArray(converted.oneOf)).toBe(true);
  });

  it('emits one oneOf branch per union member, with the discriminant enumerated', () => {
    const converted = zodToOpenApi(inferenceContentPartSchema);
    const branches = converted.oneOf as Array<Record<string, unknown>>;

    // Five members: text, image, audio, file, refusal. A count alone would pass
    // against five copies of one branch, so the discriminant values are read off.
    expect(branches).toHaveLength(5);
    const discriminants = branches.map((branch) => {
      const properties = branch.properties as Record<string, { enum?: unknown[] }>;
      return properties.type?.enum?.[0];
    });
    expect(discriminants.sort()).toEqual(['audio', 'file', 'image', 'refusal', 'text']);
  });

  it('converts a discriminated union NESTED inside another one', () => {
    // `image.source` is `inferenceContentSourceSchema`, itself a discriminated
    // union. A fix that handled only the top level would leave `{}` here, and the
    // top-level assertions above would still pass.
    const branches = zodToOpenApi(inferenceContentPartSchema).oneOf as Array<
      Record<string, unknown>
    >;
    const imageBranch = branches.find((branch) => {
      const properties = branch.properties as Record<string, { enum?: unknown[] }>;
      return properties.type?.enum?.[0] === 'image';
    });
    const source = (imageBranch?.properties as Record<string, Record<string, unknown>>).source;

    expect(source).not.toEqual({});
    expect(source.discriminator).toEqual({ propertyName: 'kind' });
    expect((source.oneOf as unknown[]).length).toBe(2);
  });

  // Name and discriminant first: `it.each` substitutes `%s` POSITIONALLY, so a
  // schema sitting between them prints the whole zod object into the test title.
  it.each([
    ['inferenceInputSchema', 'format', inferenceInputSchema],
    ['responseFormatSchema', 'type', responseFormatSchema],
    ['routingTargetSchema', 'kind', routingTargetSchema],
  ])('converts %s, whose discriminant is `%s`', (_name, discriminant, schema) => {
    const converted = zodToOpenApi(schema);
    expect(converted).not.toEqual({});
    expect(converted.discriminator).toEqual({ propertyName: discriminant });
  });

  it('reaches the union through the edge request body a generated client is built from', () => {
    // The end-to-end shape of defect 1: this is the exact position that made
    // `post_v1_chat_completions` accept anything as a message part.
    const body = zodToOpenApi(chatCompletionsRequestSchema);
    const properties = body.properties as Record<string, Record<string, unknown>>;
    const content = (
      (properties.messages.items as Record<string, unknown>).properties as Record<
        string,
        Record<string, unknown>
      >
    ).content;
    const partsBranch = (content.oneOf as Array<Record<string, unknown>>).find(
      (branch) => branch.type === 'array',
    );

    expect(partsBranch?.items).not.toEqual({});
    expect((partsBranch?.items as Record<string, unknown>).discriminator).toEqual({
      propertyName: 'type',
    });
  });

  it('still converts an ordinary object, so the assertions above are not vacuous', () => {
    expect(zodToOpenApi(z.object({ a: z.string(), b: z.number().optional() }).strict())).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
    });
  });
});

describe('zodToOpenApi: branded types', () => {
  it('unwraps a brand to the wire shape it carries', () => {
    // `oxyAccountIdSchema` is `z.string().min(1).max(64).brand<'OxyAccountId'>()`.
    // A brand is compile-time only, so the wire shape is the inner string — but
    // pre-fix `ZodBranded` had no case and the whole thing became `{}`.
    const converted = zodToOpenApi(oxyAccountIdSchema);

    expect(converted).not.toEqual({});
    expect(converted).toEqual({ type: 'string', minLength: 1, maxLength: 64 });
  });
});

describe('zodToOpenApi: numeric and length bounds', () => {
  it('keeps the TIGHTEST minimum when a chain declares several', () => {
    // The real shape from `routingPolicyVersionParams`. `.positive()` gives
    // `min 0 exclusive`, `.safe()` then gives `min -MAX_SAFE_INTEGER` inclusive;
    // taking the last published the loosest and lost the positivity.
    const converted = zodToOpenApi(z.coerce.number().int().positive().safe());

    expect(converted.type).toBe('integer');
    expect(converted.exclusiveMinimum).toBe(0);
    expect(converted.minimum).toBeUndefined();
    expect(converted.maximum).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('keeps the tightest bound whichever ORDER the chain declares it in', () => {
    const looseFirst = zodToOpenApi(z.number().min(-10).min(5));
    const tightFirst = zodToOpenApi(z.number().min(5).min(-10));
    expect(looseFirst.minimum).toBe(5);
    expect(tightFirst.minimum).toBe(5);

    const wideFirst = zodToOpenApi(z.number().max(100).max(20));
    const narrowFirst = zodToOpenApi(z.number().max(20).max(100));
    expect(wideFirst.maximum).toBe(20);
    expect(narrowFirst.maximum).toBe(20);
  });

  it('keeps the tightest string length when a chain declares several', () => {
    const converted = zodToOpenApi(z.string().min(1).max(4096).min(8).max(64));
    expect(converted.minLength).toBe(8);
    expect(converted.maxLength).toBe(64);
  });

  it('publishes a single bound unchanged, so the tightening is not overreach', () => {
    expect(zodToOpenApi(z.number().int().min(1).max(10))).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 10,
    });
  });
});

describe('zodToOpenApi: the OpenAPI 3.1 dialect', () => {
  it('spells an exclusive bound as the bound itself, never as a boolean', () => {
    const converted = zodToOpenApi(z.number().gt(3).lt(9));

    // The 3.0 form — `{ minimum: 3, exclusiveMinimum: true }` — is not merely old
    // spelling in a 3.1 document: `true` is the wrong TYPE there, so a strict
    // consumer either rejects the schema or ignores the keyword and admits 3.
    expect(converted.exclusiveMinimum).toBe(3);
    expect(converted.exclusiveMaximum).toBe(9);
    expect(converted.minimum).toBeUndefined();
    expect(converted.maximum).toBeUndefined();
  });

  it('spells nullability as a type union, never as `nullable`', () => {
    const converted = zodToOpenApi(z.string().min(2).nullable());

    expect(converted.nullable).toBeUndefined();
    expect(converted.type).toEqual(['string', 'null']);
    // The rest of the inner schema survives the widening.
    expect(converted.minLength).toBe(2);
  });

  it('admits null in an enum as well as in the type, or the widening admits nothing', () => {
    const converted = zodToOpenApi(z.enum(['a', 'b']).nullable());

    expect(converted.type).toEqual(['string', 'null']);
    expect(converted.enum).toEqual(['a', 'b', null]);
  });

  it('widens a nullable union by adding a null branch rather than a type key', () => {
    const converted = zodToOpenApi(z.union([z.string(), z.number()]).nullable());

    expect(converted.nullable).toBeUndefined();
    expect(converted.oneOf).toEqual([{ type: 'string' }, { type: 'number' }, { type: 'null' }]);
  });

  it('leaves an already-unconstrained inner schema alone, which already admits null', () => {
    expect(zodToOpenApi(z.unknown().nullable())).toEqual({});
  });
});
