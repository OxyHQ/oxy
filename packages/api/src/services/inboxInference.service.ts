import { eq } from 'drizzle-orm';
import type { InferenceError, InferenceMessage, ResponseFormat } from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { INBOX_APPLICATION_ID, INBOX_ROUTING_PROFILE_ID } from '../config/inboxInference';
import { applications } from '../db/schema/applications';
import { inferenceRoutingProfiles } from '../db/schema/inferenceRoutingProfiles';
import type { NormalizedEdgeRequest } from '../schemas/inferenceEdge.schemas';
import { inboxServiceIdentity } from '../capabilities/inbox-service-client';
import { resolveLiveAgencyWorkloadByHandle } from './agencyServicePrincipal.service';
import { resolveCredentialAttribution } from './attribution.service';
import { ownWorkloadIdentity } from './ownWorkloadIdentity.service';
import { AttestationError, type AttestedWorkload } from './workloadAttestation.service';
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
import { workloadTokenEnvironment } from '../utils/credentialEnvironment';
import { logger } from '../utils/logger';

export type InboxPointInferenceFeature =
  | 'compose'
  | 'daily_brief'
  | 'natural_search'
  | 'smart_replies'
  | 'thread_summary'
  | 'automatic_labeling'
  | 'card_extraction';

const configuredKaanaClient = createHttpKaanaClient();

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

/** The attribution half of the Inbox authority: who pays, under which identity, with what. */
interface InboxAttribution {
  readonly credentialId: string;
  readonly ownerAccountId: string;
  readonly environment: EdgePrincipal['environment'];
  readonly scopes: EdgePrincipal['scopes'];
}

function unavailable(message: string): ApiError {
  return new ApiError(503, message, 'INBOX_INFERENCE_UNAVAILABLE');
}

/**
 * Resolve both identities by exact opaque values. The attribution comes from
 * the ONE decision `inboxServiceIdentity` makes for every Inbox caller — a full
 * key pair's credential, else this task's workload binding — and must resolve
 * to the pinned Inbox application id; the routing profile is the fixed
 * `instant` power level ({@link INBOX_ROUTING_PROFILE_ID}), queried by primary
 * key, never slug/name/order.
 */
async function resolveInboxInferenceAuthority(): Promise<InboxInferenceAuthority> {
  const identity = inboxServiceIdentity();
  let attribution: InboxAttribution;
  if (identity.kind === 'credential') {
    attribution = await credentialAttribution();
  } else if (identity.kind === 'workload') {
    attribution = await workloadAttribution();
  } else {
    throw unavailable('Inbox inference is not configured.');
  }
  if (!attribution.scopes.includes('inference:invoke')) {
    throw unavailable('Inbox inference identity lacks its required scope.');
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
      .where(eq(inferenceRoutingProfiles.id, INBOX_ROUTING_PROFILE_ID))
      .limit(1),
  ]);
  if (!application || !profile) {
    throw unavailable('Inbox inference routing is unavailable.');
  }

  return {
    principal: {
      // The human session authorizes this product call. The server-held Inbox
      // credential, or this task's Inbox binding, is an exact, revocable
      // attribution anchor, not caller auth.
      lane: 'product_session',
      applicationId: INBOX_APPLICATION_ID,
      credentialId: attribution.credentialId,
      ownerAccountId: attribution.ownerAccountId,
      environment: attribution.environment,
      scopes: attribution.scopes,
      applicationType: application.type,
      applicationIsInternal: application.isInternal,
    },
    routingProfileId: profile.id,
  };
}

/**
 * The key-pair path, unchanged: the credential public key is an exact
 * configured selector and must resolve to an active SERVICE credential of the
 * pinned Inbox application.
 */
async function credentialAttribution(): Promise<InboxAttribution> {
  // These are exact opaque selectors. Whitespace or any other byte mismatch
  // must fail closed instead of being normalized into a different authority.
  const credentialPublicKey = process.env.INBOX_APPLICATION_KEY;
  if (!credentialPublicKey) {
    throw unavailable('Inbox inference is not configured.');
  }

  const attribution = await resolveCredentialAttribution(credentialPublicKey);
  if (
    attribution.status !== 'resolved' ||
    attribution.attribution.application.applicationId !== INBOX_APPLICATION_ID ||
    attribution.attribution.application.applicationStatus !== 'active' ||
    attribution.attribution.credentialType !== 'service'
  ) {
    throw unavailable('Inbox inference identity is unavailable.');
  }
  return {
    credentialId: attribution.attribution.credentialId,
    ownerAccountId: attribution.attribution.application.ownerAccountId,
    environment: attribution.attribution.credentialEnvironment,
    scopes: intersectScopes(
      attribution.attribution.credentialScopes,
      attribution.attribution.applicationScopes,
    ),
  };
}

let workloadAttributionAnnounced = false;

/**
 * The ADR 0026 path: the live binding of the role THIS task runs as.
 *
 * No HTTP and no token: the process learns its role from STS through the same
 * verifier every mint uses (`ownWorkloadIdentity`), derives the same `wl_…`
 * handle a token minted by this task would carry, and asks the one definition
 * of "a live binding", {@link resolveLiveAgencyWorkloadByHandle}, scoped to
 * the pinned Inbox application. That refuses — on every call, so a deleted or
 * re-pointed binding stops this on the next request — a binding of this role
 * to any other application, an expired binding, one with no materialised
 * attribution row (the usage ledger's foreign key), an inactive or no longer
 * first-party application and a suspended or fenced owner. The scopes are the
 * binding's intersected with the application's, exactly what the mint grants.
 *
 * The subject is compared as well as the handle: the handle is a digest of it,
 * and the binding row is the authority, not the digest.
 */
async function workloadAttribution(): Promise<InboxAttribution> {
  let own: AttestedWorkload | null;
  try {
    own = await ownWorkloadIdentity();
  } catch (error: unknown) {
    logger.warn('[InboxInference] this task could not attest its workload identity', {
      reason: error instanceof AttestationError ? error.reason : 'attestation_failed',
    });
    throw unavailable('Inbox inference identity is unavailable.');
  }
  if (own === null) {
    throw unavailable('Inbox inference is not configured.');
  }

  const binding = await resolveLiveAgencyWorkloadByHandle(INBOX_APPLICATION_ID, own.attestationId);
  if (binding === null || binding.provider !== own.provider || binding.subject !== own.subject) {
    throw unavailable('Inbox inference identity is unavailable.');
  }
  if (!workloadAttributionAnnounced) {
    workloadAttributionAnnounced = true;
    // Once per process: the rollout's evidence that inference moved off the
    // key pair. The handle is not a secret; the subject stays out of the log.
    logger.info("[InboxInference] Inbox authority resolved from this task's workload binding", {
      applicationId: INBOX_APPLICATION_ID,
      credentialId: binding.handle,
    });
  }
  return {
    credentialId: binding.handle,
    ownerAccountId: binding.ownerAccountId,
    // A binding has no environment: the deployment's, by the one definition
    // the mint writes into a token's claim.
    environment: workloadTokenEnvironment(),
    scopes: binding.scopes,
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
  return {
    requestId: allocateRequestId(),
    receivedAt: performance.now(),
    principal: authority.principal,
    request,
    delegatedUserId: input.userId,
    apiFormat: 'responses',
    endpoint: `/email/ai/${input.feature}`,
    signal: input.signal,
    ...(configuredKaanaClient === undefined ? {} : { kaanaClient: configuredKaanaClient }),
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
  return new ApiError(inferenceErrorStatus(error.code), error.message, error.code, {
    requestId: error.requestId,
    retryable: error.retryable,
  });
}
