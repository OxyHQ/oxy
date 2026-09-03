/**
 * The normalized inference request — the canonical internal envelope Oxy's
 * public edge forwards to the data plane.
 *
 * The public surface speaks several dialects (`/v1/responses`,
 * `/v1/chat/completions`, embeddings, images, audio). Exactly one of them is
 * normalized here, at the edge, so that routing, metering, policy enforcement
 * and settlement are written once against one shape instead of once per dialect.
 * `client.apiFormat` records which dialect the customer used, because the
 * response has to be rendered back in it.
 *
 * What the envelope carries that a provider request does not: the resolved
 * attribution block (who pays, which application, which credential, which
 * delegated user), the exact routing policy reference, the routes that policy
 * has already authorized, and the customer's idempotency key. Those are the
 * fields that make a request billable and explainable, and they are resolved
 * BEFORE the request enters the data plane.
 *
 * The policy VALUES never travel. `routingPolicy` is a reference — provenance
 * for the receipt — and `authorizedRoutes` is the result of applying the policy,
 * in preference order, so the data plane needs no policy semantics to fail over.
 *
 * Decided in: docs/adr/0010-public-api-compatibility.md,
 * docs/adr/0017-authorized-routes-in-the-envelope.md.
 */

import { z } from "zod";
import { inferenceAttributionSchema } from "./attribution";
import { inferenceModalitySchema } from "./catalogue";
import { idempotencyKeySchema, inferenceTimestampSchema } from "./identifiers";
import {
  authorizedRouteSchema,
  routingPolicyReferenceSchema,
  routingTargetSchema,
} from "./routingPolicy";

/* -------------------------------------------------------------------------- */
/*  Input                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Where binary or remote content comes from.
 *
 * `url` is fetched by the data plane; `inline` carries base64 the customer sent
 * with the request. Both are transient: neither is persisted by default, and
 * neither appears in a receipt, a log line or a telemetry event.
 */
export const inferenceContentSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("url"), url: z.string().min(1).max(4096) })
    .strict(),
  z
    .object({
      kind: z.literal("inline"),
      mediaType: z.string().min(1).max(255),
      data: z.string().min(1),
    })
    .strict(),
]);

/**
 * One part of a message's content. A message is always a list of parts.
 *
 * ## `refusal` is a member and `reasoning` is not, and the asymmetry is the point
 *
 * A model that DECLINES says why, and those words are meant for the customer:
 * they are the difference between "rephrase this" and "stop asking". Before this
 * member existed there was nowhere in an {@link InferenceMessage} to put them, so
 * a non-streaming fold kept `finishReason: 'refusal'` and dropped the sentence —
 * the customer learned they were refused and not why, while a streaming caller of
 * the same request got the whole explanation on the `refusal` delta channel.
 *
 * Reasoning is the opposite case and stays absent. It is the model's private
 * working, and a `text` part is where somebody would put it — which renders
 * private reasoning to the customer AS the answer, the product bug the delta
 * channels exist to prevent. An opaque per-block reasoning blob crossing this
 * boundary needs a home nobody has chosen yet, and inventing one here would
 * choose it by accident.
 *
 * Both public dialects can carry a refusal, which is what separates the two
 * cases at the boundary as well as in principle: `refusal` is OpenAI's OWN field
 * in both of its shapes (`delta.refusal` streaming, `message.refusal`
 * non-streaming), while reasoning has no OpenAI field at all — the
 * `reasoning_content`/`reasoning` spellings an OpenAI-compatible provider emits
 * are provider extensions. So carrying the refusal costs no dialect its
 * standard-client parseability, and carrying reasoning would.
 *
 * The part is a MEMBER rather than a field because a refusal need not have text:
 * an Anthropic `stop_reason: "refusal"` maps to the finish reason and separates
 * no words from the answer, while an OpenAI-compatible `refusal` does. A required
 * field would force the first provider to invent a sentence.
 */
export const inferenceContentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z
    .object({
      type: z.literal("image"),
      source: inferenceContentSourceSchema,
      /** Provider-independent hint; providers that ignore it are unaffected. */
      detail: z.enum(["auto", "low", "high"]).optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("audio"), source: inferenceContentSourceSchema })
    .strict(),
  z
    .object({
      type: z.literal("file"),
      source: inferenceContentSourceSchema,
      filename: z.string().max(255).optional(),
    })
    .strict(),
  /**
   * A model's explanation for declining. Its own part, never a `text` one, so no
   * renderer can present a refusal as the answer that was asked for.
   */
  z.object({ type: z.literal("refusal"), text: z.string() }).strict(),
]);

/**
 * A tool call an assistant made, in the normalized form.
 *
 * `arguments` is the JSON TEXT the model emitted, not a parsed object: models
 * emit invalid JSON often enough that parsing it here would turn a recoverable
 * model mistake into a rejected message.
 */
export const inferenceToolCallSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(128),
    arguments: z.string(),
  })
  .strict();

export const inferenceMessageRoleSchema = z.enum([
  "system",
  "developer",
  "user",
  "assistant",
  "tool",
]);

/**
 * One normalized message.
 *
 * The role-specific fields are refined rather than modelled as a discriminated
 * union so the shape stays the one a caller recognises from the OpenAI-style
 * dialects; the refinement is what stops `toolCallId` from riding on a user
 * message, where every provider would silently ignore it.
 */
export const inferenceMessageSchema = z
  .object({
    role: inferenceMessageRoleSchema,
    content: z.array(inferenceContentPartSchema),
    /** Participant name, where the dialect supports naming participants. */
    name: z.string().max(128).optional(),
    /** The tool call this message answers. Required on, and only on, `tool`. */
    toolCallId: z.string().min(1).max(128).optional(),
    /** Tool calls the assistant made. Only on `assistant`. */
    toolCalls: z.array(inferenceToolCallSchema).optional(),
  })
  .strict()
  .superRefine((message, ctx) => {
    if (message.role === "tool" && message.toolCallId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toolCallId"],
        message: "a tool message must name the tool call it answers",
      });
    }

    if (message.role !== "tool" && message.toolCallId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toolCallId"],
        message: "only a tool message answers a tool call",
      });
    }

    if (message.role !== "assistant" && message.toolCalls !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toolCalls"],
        message: "only an assistant message makes tool calls",
      });
    }

    // Same rule as `toolCalls`, for the same reason: only the assistant can
    // decline, so a refusal on any other role is a part every provider would
    // silently ignore — and one a renderer might not.
    if (message.role !== "assistant") {
      for (const [index, part] of message.content.entries()) {
        if (part.type === "refusal") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["content", index, "type"],
            message: "only an assistant message carries a refusal",
          });
        }
      }
    }
  });

/**
 * The request's input.
 *
 * Three formats, because the modalities genuinely differ: a chat request is a
 * conversation, an embedding request is a string or a batch of strings, and
 * pretending the latter is a one-message conversation loses the batch boundary
 * that both metering and provider translation depend on.
 */
export const inferenceInputSchema = z.discriminatedUnion("format", [
  z
    .object({
      format: z.literal("messages"),
      messages: z.array(inferenceMessageSchema).min(1),
    })
    .strict(),
  z.object({ format: z.literal("text"), text: z.string() }).strict(),
  z
    .object({
      format: z.literal("text_batch"),
      texts: z.array(z.string()).min(1).max(2048),
    })
    .strict(),
]);

/* -------------------------------------------------------------------------- */
/*  Generation controls                                                       */
/* -------------------------------------------------------------------------- */

/** Sampling parameters, all optional: absent means the route's own default. */
export const samplingParametersSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
    topK: z.number().int().positive().safe().optional(),
    frequencyPenalty: z.number().min(-2).max(2).optional(),
    presencePenalty: z.number().min(-2).max(2).optional(),
    /** A seed makes a request reproducible on providers that honour one. */
    seed: z.number().int().safe().optional(),
    stopSequences: z.array(z.string().min(1).max(256)).max(8).optional(),
  })
  .strict();

/**
 * A tool the model may call. `parameters` is a JSON Schema document, carried
 * as an opaque object: validating the customer's JSON Schema against a meta
 * schema here would reject documents providers accept.
 */
export const toolDefinitionSchema = z
  .object({
    type: z.literal("function"),
    name: z.string().min(1).max(128),
    description: z.string().max(2000).optional(),
    parameters: z.record(z.unknown()),
    /** Ask the provider to enforce the schema, where it supports enforcement. */
    strict: z.boolean().optional(),
  })
  .strict();

/** Whether, and which, tool the model must call. */
export const toolChoiceSchema = z.union([
  z.enum(["auto", "none", "required"]),
  z
    .object({ type: z.literal("function"), name: z.string().min(1).max(128) })
    .strict(),
]);

/** Structured-output request: free text, any JSON object, or a named schema. */
export const responseFormatSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }).strict(),
  z.object({ type: z.literal("json_object") }).strict(),
  z
    .object({
      type: z.literal("json_schema"),
      name: z.string().min(1).max(128),
      schema: z.record(z.unknown()),
      strict: z.boolean(),
    })
    .strict(),
]);

/* -------------------------------------------------------------------------- */
/*  Client metadata                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What the edge records about the CALL, as opposed to its content.
 *
 * `.strict()` is a privacy control, not tidiness. Oxy never persists a user IP
 * — raw, hashed or geo-derived — and this object is the natural place somebody
 * would add one "for security". Strict means a producer that attaches `ip`,
 * `country`, `userAgent` or `forwardedFor` fails the parse instead of quietly
 * shipping it into the data plane and the telemetry stream behind it.
 *
 * `labels` is customer-supplied cost-attribution metadata (a team name, a
 * feature flag). It is echoed on the receipt, so it must never be used for
 * anything the customer would not want to read back to themselves.
 */
export const clientRequestMetadataSchema = z
  .object({
    /** The public dialect the customer called. The response is rendered in it. */
    apiFormat: z.enum([
      "responses",
      "chat_completions",
      "embeddings",
      "images_generations",
      "audio_transcriptions",
      "audio_speech",
      "rerank",
      "batches",
    ]),
    /** The public path, e.g. `/v1/responses`. */
    endpoint: z.string().min(1).max(256),
    /** The customer's own correlation id, when they sent one. */
    clientRequestId: z.string().min(1).max(128).optional(),
    receivedAt: inferenceTimestampSchema,
    labels: z.record(z.string().max(256)).optional(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/*  The envelope                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The model LINE a reference names, with any pinned revision dropped.
 *
 * Substitution is a question about the line — `anthropic/claude-opus-5` — never
 * about the revision, so the comparisons below have to be made on it. Same split
 * `resolveEdgeRoute` makes on the way in.
 */
const modelLineOf = (reference: string): string => {
  const at = reference.indexOf("@");
  return at === -1 ? reference : reference.slice(0, at);
};

/**
 * The canonical internal request Oxy forwards to the data plane.
 *
 * `target` distinguishes the two questions a caller can ask — "serve THIS
 * model" versus "choose one for me" — structurally. Everything downstream that
 * must not silently substitute a model reads that discriminant rather than
 * inferring intent from a string.
 */
export const inferenceRequestSchema = z
  .object({
    /** See `version.ts`: this is the Oxy→data-plane request envelope. */
    schemaVersion: z.literal(2),
    attribution: inferenceAttributionSchema,
    target: routingTargetSchema,
    modality: inferenceModalitySchema,
    input: inferenceInputSchema,
    stream: z.boolean(),
    maxOutputTokens: z.number().int().positive().safe().optional(),
    sampling: samplingParametersSchema,
    tools: z.array(toolDefinitionSchema).default([]),
    toolChoice: toolChoiceSchema.optional(),
    responseFormat: responseFormatSchema.optional(),
    client: clientRequestMetadataSchema,
    /** Present when the operation is safe to deduplicate on retry. */
    idempotencyKey: idempotencyKeySchema.optional(),
    /** The exact policy revision this request is served under. */
    routingPolicy: routingPolicyReferenceSchema,
    /**
     * The routes the control plane has already authorized for this request, in
     * PREFERENCE ORDER. The first entry is the primary route Oxy resolved; the
     * data plane fails over by taking the next one.
     *
     * This is what closes the gap ADR 0010's amendment left open. That amendment
     * assigns the data plane "failover within the destinations the policy
     * authorized" — and the envelope named no destinations, so a data plane could
     * only fail over by re-deriving the customer's policy from values it does not
     * have. Enumerating the survivors instead means a route switch outside the
     * policy is impossible BY CONSTRUCTION rather than by two enforcement engines
     * agreeing in two languages.
     *
     * **Absent means no failover is authorized, never "choose freely."** It is
     * the state every envelope built before this field existed is in, and the
     * behaviour a data plane that reads no list must already have: resolve the
     * `target` and serve it or fail. Permission is granted by an ENTRY, so its
     * absence can only ever narrow, and there is no reading of an absent list
     * that widens what may be served.
     *
     * An EMPTY list is refused rather than treated as that state. `[]` would say
     * "no route is authorized at all", which contradicts an envelope that was
     * built to be served, and it is exactly the "permission granted, destination
     * unnamed" shape `authorizedRouteSchema` exists to make unrepresentable.
     *
     * No price rides here. Oxy sized the hold against the most expensive route
     * the policy permits (`usageReservationRequestSchema.ceilingPriceVersionId`),
     * and every entry is one that policy permitted, so no failover among them can
     * exceed it. A per-route price would also be a second authority for ranking,
     * beside the order this list already carries.
     */
    authorizedRoutes: z.array(authorizedRouteSchema).min(1).optional(),
  })
  .superRefine((request, ctx) => {
    if (request.toolChoice !== undefined && request.tools.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toolChoice"],
        message: "a tool choice requires at least one tool definition",
      });
    }

    const toolNames = request.tools.map((tool) => tool.name);
    if (new Set(toolNames).size !== toolNames.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tools"],
        message: "tool names must be unique within one request",
      });
    }

    const routes = request.authorizedRoutes;
    // The emptiness is RE-CHECKED rather than assumed away by `.min(1)`. A
    // failed `.min()` marks the parse dirty rather than aborting it, so zod runs
    // this refinement with the empty array still in hand; `[]` is already
    // refused above, and reading `routes[0]` here would throw instead.
    if (routes === undefined || routes.length === 0) return;

    const primary = routes[0];

    // The primary is not a substitution for itself, and every `substitution`
    // value is read RELATIVE to it. A list whose first entry claims to be a
    // cross-model substitute names no original to have substituted for.
    if (primary.substitution !== "same_model") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authorizedRoutes", 0, "substitution"],
        message:
          "the first authorized route is the primary and cannot be a substitution",
      });
    }

    const primaryLine = modelLineOf(primary.modelReference);

    // A request that named a concrete model is served or refused, never
    // substituted, and one that PINNED a revision is served on exactly those
    // weights. Both checks are on the primary, because a primary that already
    // drifted makes every entry after it a substitution nobody labelled.
    if (request.target.kind === "model") {
      const targetReference = request.target.modelReference;
      const targetIsPinned = targetReference.includes("@");

      if (targetIsPinned && primary.modelReference !== targetReference) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["authorizedRoutes", 0, "modelReference"],
          message:
            "a pinned request is served on exactly the revision it pinned",
        });
      }

      if (!targetIsPinned && primaryLine !== targetReference) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["authorizedRoutes", 0, "modelReference"],
          message:
            "the primary authorized route must serve the model the request named",
        });
      }

      if (targetIsPinned) {
        for (const [index, route] of routes.entries()) {
          if (route.substitution === "cross_model") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["authorizedRoutes", index, "substitution"],
              message:
                "a request that pinned a revision authorizes no cross-model substitute",
            });
          }
        }
      }
    }

    for (const [index, route] of routes.entries()) {
      const line = modelLineOf(route.modelReference);

      // A mislabelled entry is the whole failure mode: `same_model` on a
      // different model line is a substitution wearing the label that needs no
      // authorization, and `cross_model` on the same line claims an
      // authorization the customer never had to give.
      if (route.substitution === "same_model" && line !== primaryLine) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["authorizedRoutes", index, "substitution"],
          message: `route ${index} serves ${line}, not ${primaryLine}, so it is a cross-model substitute`,
        });
      }

      if (route.substitution === "cross_model" && line === primaryLine) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["authorizedRoutes", index, "substitution"],
          message: `route ${index} serves ${primaryLine}, so it is same-model failover`,
        });
      }
    }

    // Failing over to the deployment that just failed is not failover. The
    // duplicate would also make `routeSwitches` count a switch that changed
    // nothing.
    const deployments = routes.map((route) => route.deploymentId);
    if (new Set(deployments).size !== deployments.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authorizedRoutes"],
        message:
          "each deployment appears at most once in the authorized route list",
      });
    }
  });

export type InferenceContentSource = z.infer<
  typeof inferenceContentSourceSchema
>;
export type InferenceContentPart = z.infer<typeof inferenceContentPartSchema>;
export type InferenceToolCall = z.infer<typeof inferenceToolCallSchema>;
export type InferenceMessageRole = z.infer<typeof inferenceMessageRoleSchema>;
export type InferenceMessage = z.infer<typeof inferenceMessageSchema>;
export type InferenceInput = z.infer<typeof inferenceInputSchema>;
export type SamplingParameters = z.infer<typeof samplingParametersSchema>;
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;
export type ToolChoice = z.infer<typeof toolChoiceSchema>;
export type ResponseFormat = z.infer<typeof responseFormatSchema>;
export type ClientRequestMetadata = z.infer<typeof clientRequestMetadataSchema>;
export type InferenceRequest = z.infer<typeof inferenceRequestSchema>;
