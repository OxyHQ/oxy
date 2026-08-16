/**
 * The SDK's request type and the edge's request schema, held together
 * (issue #972, workstream 15).
 *
 * `@oxyhq/core`'s `OxyResponsesRequest` names the fields a customer sends to
 * `POST /v1/responses`. `responsesRequestSchema` decides which fields are
 * accepted. They are two declarations of one wire shape and they live in
 * different packages — the schema stays here because it is a PUBLIC DIALECT
 * rather than an Oxy↔data-plane contract, and core cannot import from the API.
 * So the drift has to be caught by a test rather than prevented by a type.
 *
 * Two directions, and neither catches the other:
 *
 *  - **A field the SDK sends that the schema does not accept.** `.strict()`
 *    rejects it, so parsing an exhaustive value typed as `OxyResponsesRequest`
 *    fails. That is the direction a rename breaks, and it breaks a CUSTOMER's
 *    request rather than a build, which is why it is worth a test at all.
 *  - **A field the schema accepts that the SDK cannot express.** A parse would
 *    pass happily; only comparing the key SETS sees it. The comparison is exact
 *    with one named exemption, so it cannot erode into a subset check.
 *
 * The vacuity floor is the negative control below: a typo'd key must fail. Every
 * assertion here would pass against a schema that accepted anything, and that
 * control is what proves it does not.
 */

import type { OxyResponsesRequest } from '@oxyhq/core';
import { responsesRequestSchema } from '../inferenceEdge.schemas';

/**
 * Fields `responsesRequestSchema` accepts and `OxyResponsesRequest` deliberately
 * does not declare.
 *
 * EXACT, not a floor: an entry here is a capability the SDK cannot express, and
 * a growing list is the gate switching itself off one defensible line at a time.
 *
 * `stream` — the edge refuses `stream: true` with `invalid_request` because
 * there is no data plane to stream from, so a client field that could only ever
 * produce a refusal would be a worse artefact than an absent one. When streaming
 * ships, this entry is removed in the same change that adds the SDK method.
 */
const SDK_OMITTED_FIELDS = ['stream'] as const;

/**
 * Every field of `OxyResponsesRequest`, populated.
 *
 * Typed as `OxyResponsesRequest`, so a field the SDK drops fails `tsc` here and
 * a field it renames fails the parse below. Values are shaped to satisfy the
 * schema's own bounds; the model id is a grammatical example and names nothing
 * Oxy serves — the catalogue is empty.
 */
const exhaustiveRequest: OxyResponsesRequest = {
  model: 'acme/some-model',
  input: 'hello',
  maxOutputTokens: 256,
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  frequencyPenalty: 0.1,
  presencePenalty: 0.1,
  seed: 42,
  stopSequences: ['\n\n'],
  tools: [
    {
      type: 'function',
      name: 'lookup',
      description: 'Look something up',
      parameters: { type: 'object' },
      strict: true,
    },
  ],
  toolChoice: 'auto',
  responseFormat: { type: 'json_object' },
  labels: { team: 'search' },
  clientRequestId: 'client-1',
};

/**
 * `routingProfile` is the one field the exhaustive value cannot carry, because
 * naming it beside `model` is refused by the schema's own exclusivity rule. It
 * gets its own value rather than being left out, so the key comparison below
 * still sees it.
 */
const profileRequest: OxyResponsesRequest = {
  routingProfile: 'auto',
  input: 'hello',
};

describe('OxyResponsesRequest ↔ responsesRequestSchema', () => {
  it('accepts every field the SDK can send', () => {
    const parsed = responsesRequestSchema.safeParse(exhaustiveRequest);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });

  it('accepts the routing-profile form the SDK can also send', () => {
    const parsed = responsesRequestSchema.safeParse(profileRequest);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });

  it('negative control: an unknown field is refused, so the two above are not vacuous', () => {
    const parsed = responsesRequestSchema.safeParse({
      ...exhaustiveRequest,
      maxOutputTokns: 256,
    });
    expect(parsed.success).toBe(false);
  });

  it('the SDK can express every field the schema accepts, but the named exemptions', () => {
    // The other direction: a capability added to the edge that no SDK caller
    // can reach parses fine and would be invisible to the cases above.
    const schemaFields = Object.keys(responsesRequestSchema.innerType().shape).sort();
    const sdkFields = [
      ...new Set([...Object.keys(exhaustiveRequest), ...Object.keys(profileRequest)]),
    ].sort();

    expect(schemaFields).toEqual([...sdkFields, ...SDK_OMITTED_FIELDS].sort());
  });

  it('the exemption list is exactly what it claims to be', () => {
    // An exact count, so an entry cannot be appended to make a failure go away
    // without somebody editing this number and answering for it.
    expect(SDK_OMITTED_FIELDS).toEqual(['stream']);
  });
});
