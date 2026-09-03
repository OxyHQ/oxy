import { eq } from 'drizzle-orm';
import {
  type InferenceError,
  type InferenceMessage,
  type ResponseFormat,
} from '@oxyhq/contracts';
import { getDb } from '../config/postgres';
import { isKaanaExecutionEnabled } from '../config/rolloutFlags';
import { INBOX_APPLICATION_ID } from '../config/inboxInference';
import { applications } from '../db/schema/applications';
import { inferenceRoutingProfiles } from '../db/schema/inferenceRoutingProfiles';
import type { NormalizedEdgeRequest } from '../schemas/inferenceEdge.schemas';
import { resolveCredentialAttribution } from './attribution.service';
import {
  allocateRequestId,
  executeInferenceRequest,
  streamInferenceRequest,
  type EdgeCompletion,
  type EdgeExecutionContext,
  type EdgePrincipal,
  type EdgeStreamFrame,
} from './inferenceEdge.service';
import { createHttpKaanaClient } from './httpKaanaClient';
import { inferenceErrorStatus } from '../utils/inferenceEdgeErrors';
import { ApiError } from '../utils/error';
import { intersectScopes } from '../utils/applicationScopes';

export type InboxPointInferenceFeature =
  | 'compose'
  | 'daily_brief'
  | 'natural_search'
  | 'smart_replies'
  | 'thread_summary'
  | 'automatic_labeling'
  | 'card_extraction';

export interface InboxPointInferenceInput {
  readonly userId: string;
  readonly feature: InboxPointInferenceFeature;
  readonly messages: readonly InferenceMessage[];
  readonly maxOutputTokens: number;
  readonly temperature: number;
  readonly responseFormat?: ResponseFormat;
  readonly signal: AbortSignal;
  readonly stream?: boolean;
}

interface InboxInferenceAuthority {
  readonly principal: EdgePrincipal;
  readonly routingProfileId: string;
}

/**
 * Resolve both identities by exact opaque values. The credential public key is
 * an exact configured selector and must resolve to the pinned Inbox application
 * id; the routing-profile id is queried by primary key, never slug/name/order.
 */
async function resolveInboxInferenceAuthority(): Promise<InboxInferenceAuthority> {
  // These are exact opaque selectors. Whitespace or any other byte mismatch
  // must fail closed instead of being normalized into a different authority.
  const credentialPublicKey = process.env.INBOX_APPLICATION_KEY;
  const routingProfileId = process.env.INBOX_INFERENCE_ROUTING_PROFILE_ID;
  if (!credentialPublicKey || !routingProfileId) {
    throw new ApiError(
      503,
      'Inbox inference is not configured.',
      'INBOX_INFERENCE_UNAVAILABLE',
    );
  }

  const attribution = await resolveCredentialAttribution(credentialPublicKey);
  if (
    attribution.status !== 'resolved' ||
    attribution.attribution.application.applicationId !== INBOX_APPLICATION_ID ||
    attribution.attribution.application.applicationStatus !== 'active' ||
    attribution.attribution.credentialType !== 'service'
  ) {
    throw new ApiError(
      503,
      'Inbox inference identity is unavailable.',
      'INBOX_INFERENCE_UNAVAILABLE',
    );
  }
  const effectiveScopes = intersectScopes(
    attribution.attribution.credentialScopes,
    attribution.attribution.applicationScopes,
  );
  if (!effectiveScopes.includes('inference:invoke')) {
    throw new ApiError(
      503,
      'Inbox inference identity lacks its required scope.',
      'INBOX_INFERENCE_UNAVAILABLE',
    );
  }

  const [[application], [profile]] = await Promise.all([
    getDb()
      .select({ type: applications.type, isInternal: applications.isInternal })
      .from(applications)
      .where(eq(applications.id, INBOX_APPLICATION_ID))
      .limit(1),
    getDb()
      .select({ id: inferenceRoutingProfiles.id })
      .from(inferenceRoutingProfiles)
      .where(eq(inferenceRoutingProfiles.id, routingProfileId))
      .limit(1),
  ]);
  if (!application || !profile) {
    throw new ApiError(
      503,
      'Inbox inference routing is unavailable.',
      'INBOX_INFERENCE_UNAVAILABLE',
    );
  }

  return {
    principal: {
      // The human session authorizes this product call. The server-held Inbox
      // credential is an exact, revocable attribution anchor, not caller auth.
      lane: 'product_session',
      applicationId: INBOX_APPLICATION_ID,
      credentialId: attribution.attribution.credentialId,
      ownerAccountId: attribution.attribution.application.ownerAccountId,
      environment: attribution.attribution.credentialEnvironment,
      scopes: effectiveScopes,
      applicationType: application.type,
      applicationIsInternal: application.isInternal,
    },
    routingProfileId: profile.id,
  };
}

async function contextFor(input: InboxPointInferenceInput): Promise<EdgeExecutionContext> {
  const authority = await resolveInboxInferenceAuthority();
  const request: NormalizedEdgeRequest = {
    operation: { kind: 'completion' },
    target: { kind: 'routing_profile_id', routingProfileId: authority.routingProfileId },
    input: { format: 'messages', messages: [...input.messages] },
    stream: input.stream === true,
    maxOutputTokens: input.maxOutputTokens,
    sampling: { temperature: input.temperature },
    tools: [],
    ...(input.responseFormat === undefined ? {} : { responseFormat: input.responseFormat }),
    labels: { product: 'inbox', feature: input.feature },
  };
  const kaanaClient = isKaanaExecutionEnabled() ? createHttpKaanaClient() : undefined;
  return {
    requestId: allocateRequestId(),
    receivedAt: performance.now(),
    principal: authority.principal,
    request,
    delegatedUserId: input.userId,
    apiFormat: 'responses',
    endpoint: `/email/ai/${input.feature}`,
    signal: input.signal,
    ...(kaanaClient === undefined ? {} : { kaanaClient }),
  };
}

export async function executeInboxPointInference(
  input: InboxPointInferenceInput,
): Promise<EdgeCompletion> {
  const execution = await executeInferenceRequest(await contextFor(input));
  if (execution.status === 'refused') throw inferenceRefusal(execution.error);
  return execution.completion;
}

export async function* streamInboxPointInference(
  input: InboxPointInferenceInput,
): AsyncGenerator<EdgeStreamFrame> {
  yield* streamInferenceRequest(await contextFor({ ...input, stream: true }));
}

export function inboxCompletionText(completion: EdgeCompletion): string {
  return completion.output
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.content)
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function inferenceRefusal(error: InferenceError): ApiError {
  return new ApiError(
    inferenceErrorStatus(error.code),
    error.message,
    error.code,
    { requestId: error.requestId, retryable: error.retryable },
  );
}
