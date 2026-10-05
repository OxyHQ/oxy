/**
 * The production {@link KaanaClient}: a signed HTTP hop to `OxyHQ/Kaana`
 * (issue #972 workstream 4, ADR 0006, ADR 0010, ADR 0015).
 *
 * ```text
 * POST <KAANA_BASE_URL>/internal/v1/inference
 *   X-Oxy-Kaana-Key-Id      the signing key's id
 *   X-Oxy-Kaana-Timestamp   unix milliseconds
 *   X-Oxy-Kaana-Signature   v1=<base64 Ed25519 signature>
 *   <the exact serialized envelope>
 * ->  200 + text/event-stream:  event: stream_event | usage_report
 * ```
 *
 * ## The signature covers the EXACT bytes that are sent
 *
 * {@link kaanaSigningInput} hashes the serialized body and signs the hash inside
 * a domain-separated preamble, and the same `Buffer` that was hashed is the
 * request body. Re-serializing the envelope between signing and sending — two
 * `JSON.stringify` calls, or a fetch implementation given an object to encode
 * itself — would authenticate something other than what gets executed, which is
 * the classic way a signature check becomes decorative. ADR 0015 states the
 * scheme; Kaana's `internal/edgeauth` is the other implementation of it.
 *
 * ## A status code answers exactly one question
 *
 * Kaana's own rule, and the edge has to speak it: `200` means "this was a
 * well-formed signed envelope", and every outcome after that — including a
 * refusal — arrives as the stream's terminal `error` event. So a `4xx` here is
 * never about the customer's request (see {@link KaanaEnvelopeRejectedError}) and
 * the interesting failures are all inside a `200`.
 *
 * ## Nothing is buffered, in either direction
 *
 * The body is decoded frame by frame off `Response.body` and yielded as it
 * arrives. {@link HttpKaanaClient.execute} folds those frames into a completion
 * because a non-streaming caller wants one value — but it is the same call, the
 * same decoder and the same signature, so there is one wire path and no second
 * place a frame can be misread.
 *
 * ## There is no request deadline here, deliberately
 *
 * The bound on this hop is the CLIENT's own patience: when a customer's HTTP
 * client gives up, `res` closes, `connectionSignal` aborts, this request aborts
 * and Kaana propagates the cancellation upstream. A deadline of Oxy's own would
 * be a second number that has to be larger than the slowest legitimate
 * generation and smaller than `RESERVATION_TTL_SECONDS`, and getting it wrong in
 * the first direction kills requests a customer paid for. A client that never
 * disconnects against a data plane that never answers leaves the hold standing,
 * which is precisely what the reservation's own expiry sweeper is for.
 *
 * ## What never enters a log line
 *
 * The envelope, the prompt, the output, the signature and the key. The failure
 * paths here log a request id, an HTTP status and an upstream error CODE, and the
 * edge's own test asserts a prompt marker appears in no log call.
 */

import { privateAutoInferenceRequestSchema, privateAutoSourceApprovalSchema, PRIVATE_AUTO_EXECUTION_CONTRACT_VERSION, type PrivateAutoInferenceRequest, inferenceRequestSchema, scopedInferenceRequestSchema, canonicalScopedExecutionJson, scopedExecutionAudienceSchema, SCOPED_EXECUTION_CONTRACT_VERSION, type ScopedInferenceRequest, decisionResultSchema, decisionFailureSchema, decisionAnswersMatch, inferenceErrorSchema } from '@oxy.so/contracts';

import { createHash, sign, type KeyObject } from 'node:crypto';
import {
  deploymentIdSchema,
  inferenceProviderSlugSchema,
  inferenceRegionSchema,
  inferenceStreamEventSchema,
  inferenceErrorCodeSchema,
  MAX_INFERENCE_AUDIO_BYTES,
  modelReferenceSchema,
  normalizedUsageReportSchema,
  type InferenceError,
  type InferenceFinishReason,
  type InferenceMessage,
  type InferenceRequest,
  type InferenceStreamRouteSwitchEvent,
  type InferenceToolCall,
  type NormalizedUsageReport,
  type UsageQuantity,
  type UsageSource,
} from '@oxy.so/contracts';
import { z } from 'zod';
import {
  kaanaPublicKeyBase64,
  resolveKaanaDataPlane,
  type KaanaDataPlaneConfig,
} from '../config/kaanaDataPlane';
import { logger } from '../utils/logger';
import { privateAutoClassifierSourceApproval, reviewedPrivateAutoApproval } from '../config/privateAutoClassification';
import { validatePrivateAutoAttestation } from './privateAutoAttestation.service';
import {
  KaanaEnvelopeRejectedError,
  KaanaIncompleteError,
  KaanaProtocolError,
  type KaanaClient,
  type KaanaCompletion,
  type KaanaDeploymentAttestation,
  type KaanaExecuteOptions,
  type KaanaStreamFrame,
  type KaanaUsageEvidence,
} from './kaanaClient';

/* -------------------------------------------------------------------------- */
/*  The wire                                                                  */
/* -------------------------------------------------------------------------- */

/** The one route the edge calls. */
export const KAANA_INFERENCE_PATH = '/internal/v1/inference';
export const KAANA_DEPLOYMENTS_QUERY_PATH = '/internal/v1/deployments/query';
/** Kaana's signed catalogue: every model line its snapshot serves. */
export const KAANA_MODELS_PATH = '/internal/v1/models';

export const KAANA_KEY_ID_HEADER = 'X-Oxy-Kaana-Key-Id';
export const KAANA_TIMESTAMP_HEADER = 'X-Oxy-Kaana-Timestamp';
export const KAANA_SIGNATURE_HEADER = 'X-Oxy-Kaana-Signature';

/**
 * The signature's own version, carried in the header value rather than the
 * header name so the scheme can change without a new header having to be allowed
 * through every proxy on the path.
 */
const KAANA_SIGNATURE_VERSION = 'v1';

/**
 * The domain separator. A signature minted for any other Oxy purpose cannot be
 * replayed as an inference envelope, because no other purpose signs a payload
 * that starts with this line.
 */
const KAANA_SIGNATURE_DOMAIN = 'oxy-kaana-envelope:v1';

/** Kaana's own SSE frame names — transport framing, not part of the contract. */
const FRAME_STREAM_EVENT = 'stream_event';
const FRAME_USAGE_REPORT = 'usage_report';

/**
 * The largest single SSE event this client will accumulate, in characters.
 *
 * Matches the bound Kaana's own decoder applies to what it reads from a provider,
 * and exists for the same reason: a producer that never emits a frame boundary
 * would otherwise grow this buffer until the process dies, which is a denial of
 * service that arrives looking like a memory leak. Generous — the largest frame
 * Kaana emits is a usage report, which is under a kilobyte.
 */
const MAX_KAANA_EVENT_CHARACTERS = 8 * 1024 * 1024;

/**
 * The most of a non-`200` body this client reads before giving up on it.
 *
 * Kaana's own rejections are a few hundred bytes of JSON. The cap is here for
 * what sits BETWEEN the two — a load balancer or service mesh returning an HTML
 * error page — because the error path is exactly where an unbounded read is least
 * likely to be noticed.
 */
const MAX_KAANA_REJECTION_BYTES = 64 * 1024;
const MAX_KAANA_ATTESTATION_IDS = 64;
/**
 * The largest catalogue this client reads. Hundreds of model lines with their
 * deployments and list prices are well under a megabyte; the bound exists so a
 * misbehaving intermediary cannot stream an unbounded body into the sync.
 */
const MAX_KAANA_CATALOGUE_BYTES = 16 * 1024 * 1024;

const kaanaDeploymentAttestationSchema = z
  .object({
    snapshotId: z.string().min(1).max(256),
    scopedExecutionContractVersion: z.literal(SCOPED_EXECUTION_CONTRACT_VERSION).optional(),
    privateAutoExecutionContractVersion: z.literal(PRIVATE_AUTO_EXECUTION_CONTRACT_VERSION).optional(),
    deployments: z
      .array(
        z
          .object({
            deploymentId: deploymentIdSchema,
            modelReference: modelReferenceSchema,
            provider: inferenceProviderSlugSchema,
            regions: z.array(inferenceRegionSchema),
            /**
             * The deployment's own accepted request controls, when Kaana's
             * descriptor carries them. Optional and read leniently (unknown
             * words are dropped by the sync) so the field can arrive without a
             * coordinated release; absent is unknown.
             */
            acceptedParameters: z.array(z.string().max(64)).max(64).optional(),
            scopedExecution: scopedExecutionAudienceSchema.optional(),
            privateAutoSourceApproval: privateAutoSourceApprovalSchema.optional(),
            keyId: z.string().min(1).max(256).optional(),
            upstreamModelId: z.string().min(1).max(256).optional(),
            providerRateCardVersionId: z.string().min(1).max(256).optional(),
            providerSourceVersion: z.string().min(1).max(256).optional(),
          })
          .strict()
      )
      .max(MAX_KAANA_ATTESTATION_IDS),
  })
  .strict();

/**
 * The most deployments one full serving snapshot may describe. Far above any
 * real inventory (hundreds); the bound only keeps a misbehaving intermediary
 * from handing the publication cache an unbounded set.
 */
const MAX_KAANA_PUBLISHED_DEPLOYMENTS = 20_000;

/**
 * `POST /internal/v1/deployments/query` with the empty query `{}`: every
 * deployment the serving snapshot publishes. Same descriptor shape as the exact
 * attestation, without the 64-id bound that shape carries.
 */
const kaanaPublishedDeploymentsSchema = kaanaDeploymentAttestationSchema.extend({
  deployments: kaanaDeploymentAttestationSchema.shape.deployments.element
    .array()
    .max(MAX_KAANA_PUBLISHED_DEPLOYMENTS),
});

/* -------------------------------------------------------------------------- */
/*  Signing                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The exact bytes both sides sign:
 *
 * ```text
 * oxy-kaana-envelope:v1
 * <key id>
 * <unix milliseconds>
 * <lowercase hex sha256 of the exact request body>
 * ```
 *
 * `\n` separated, with NO trailing newline. Exported because it IS the
 * specification: the test's stub Kaana verifies with this function rather than
 * with a second copy that could drift, and Kaana's Go `edgeauth.SigningInput` is
 * the same four lines. A body hash rather than the body itself so the signed
 * material is a fixed 32 bytes whatever the prompt weighs — and so the signature
 * covers the envelope rather than merely accompanying it.
 */
export function kaanaSigningInput(
  keyId: string,
  timestampMillis: number,
  body: Buffer
): Buffer<ArrayBuffer> {
  const digest = createHash('sha256').update(body).digest('hex');
  return Buffer.from(
    [KAANA_SIGNATURE_DOMAIN, keyId, String(timestampMillis), digest].join('\n'),
    'utf8'
  );
}

/** `v1=<base64 Ed25519 signature>` over {@link kaanaSigningInput}. */
function signEnvelope(
  privateKey: KeyObject,
  keyId: string,
  timestampMillis: number,
  body: Buffer
): string {
  // `null` is the algorithm for Ed25519 in Node: the curve fixes the digest, and
  // naming one here is an error rather than a preference.
  const signature = sign(null, kaanaSigningInput(keyId, timestampMillis, body), privateKey);
  return `${KAANA_SIGNATURE_VERSION}=${signature.toString('base64')}`;
}

/**
 * The three edge signature headers over `body`, for a caller outside this module
 * that sends the bytes itself — the realtime client signs the FIRST FRAME of a
 * WebSocket with exactly the inference domain the envelope uses
 * (`services/kaanaRealtimeClient.ts`). One signer, so the two cannot drift.
 */
export function kaanaSignatureHeaders(
  config: Pick<KaanaDataPlaneConfig, 'keyId' | 'privateKey'>,
  body: Buffer,
  timestampMillis: number = Date.now()
): Record<string, string> {
  return {
    [KAANA_KEY_ID_HEADER]: config.keyId,
    [KAANA_TIMESTAMP_HEADER]: String(timestampMillis),
    [KAANA_SIGNATURE_HEADER]: signEnvelope(config.privateKey, config.keyId, timestampMillis, body),
  };
}

/* -------------------------------------------------------------------------- */
/*  The client                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The data plane this deployment configured, or `undefined` when it configured
 * none.
 *
 * `undefined` is the fail-closed result for any task without all three bindings:
 * the router is built with no client and the edge answers a typed
 * `service_unavailable`. A PARTIAL configuration also resolves to `undefined`, loudly — see
 * `config/kaanaDataPlane.ts`.
 *
 * The public key is logged at startup, once, because it is the value an operator
 * has to paste into Kaana's `KAANA_EDGE_PUBLIC_KEYS` and it is not a secret.
 * Confirming both sides hold the same pair is otherwise a guess.
 */
export function createHttpKaanaClient(): KaanaClient | undefined {
  const resolution = resolveKaanaDataPlane();
  if (resolution.status !== 'configured') return undefined;

  const { config } = resolution;
  logger.info('inference.kaana.configured', {
    component: 'inference-kaana',
    baseUrl: config.baseUrl,
    keyId: config.keyId,
    publicKey: kaanaPublicKeyBase64(config),
  });
  return new HttpKaanaClient(config);
}

/**
 * Reads Kaana's signed model catalogue (`GET /internal/v1/models`) for the
 * catalogue sync. Separate from {@link KaanaClient} because it is not on the
 * request path: nothing a customer sends reaches it, and the edge's stub
 * clients need not implement it.
 */
export interface KaanaCatalogueReader {
  /**
   * The decoded JSON body, unvalidated. The sync owns the parse, because a
   * catalogue entry it cannot read is skipped and counted rather than failing
   * every other entry with it.
   */
  listModels(signal: AbortSignal): Promise<unknown>;
  /** The same signed exact-id attestation the edge's preflight uses. */
  attestDeployments(
    deploymentIds: readonly string[],
    options: KaanaExecuteOptions
  ): Promise<KaanaDeploymentAttestation>;
  /**
   * Every deployment Kaana's CURRENT serving snapshot publishes (the signed
   * `{}` deployment query). A deployment Kaana withholds — exhausted
   * credential, sustained failure — is absent from it. Read by the
   * publication cache (`kaanaDeploymentPublication.service.ts`), never by a
   * request as a selector.
   */
  listPublishedDeployments(signal: AbortSignal): Promise<KaanaDeploymentAttestation>;
}

/** Read-only projections negotiate each independent private contract separately. */
function catalogueNegotiations(): Pick<KaanaExecuteOptions, 'scopedExecutionContractVersion' | 'privateAutoExecutionContractVersion'>[] {
  const negotiations: Pick<KaanaExecuteOptions, 'scopedExecutionContractVersion' | 'privateAutoExecutionContractVersion'>[] = [
    { scopedExecutionContractVersion: SCOPED_EXECUTION_CONTRACT_VERSION },
  ];
  if (reviewedPrivateAutoApproval(privateAutoClassifierSourceApproval()) !== undefined) {
    negotiations.push({ privateAutoExecutionContractVersion: PRIVATE_AUTO_EXECUTION_CONTRACT_VERSION });
  }
  return negotiations;
}

/** Only local read composition carries both acknowledgements; no wire query does. */
export function mergeNegotiatedDeploymentReads(
  scoped: KaanaDeploymentAttestation,
  auto: KaanaDeploymentAttestation,
): KaanaDeploymentAttestation {
  if (scoped.snapshotId !== auto.snapshotId || scoped.scopedExecutionContractVersion !== SCOPED_EXECUTION_CONTRACT_VERSION ||
    scoped.privateAutoExecutionContractVersion !== undefined || auto.scopedExecutionContractVersion !== undefined ||
    auto.privateAutoExecutionContractVersion !== PRIVATE_AUTO_EXECUTION_CONTRACT_VERSION) {
    throw new KaanaProtocolError('Independent catalogue projections do not match one snapshot and negotiation.');
  }
  const ordinaryIds = (evidence: KaanaDeploymentAttestation) => evidence.deployments
    .filter(row => row.scopedExecution === undefined && row.privateAutoSourceApproval === undefined)
    .map(row => row.deploymentId).sort();
  if (canonicalScopedExecutionJson(ordinaryIds(scoped)) !== canonicalScopedExecutionJson(ordinaryIds(auto))) {
    throw new KaanaProtocolError('Independent catalogue ordinary deployment sets conflict.');
  }
  const descriptors = new Map<string, KaanaDeploymentAttestation['deployments'][number]>();
  for (const [lane, evidence] of [['scoped', scoped], ['auto', auto]] as const) {
    const seen = new Set<string>();
    for (const descriptor of evidence.deployments) {
      if (seen.has(descriptor.deploymentId) ||
        (lane === 'scoped' && descriptor.privateAutoSourceApproval !== undefined) ||
        (lane === 'auto' && descriptor.scopedExecution !== undefined)) {
        throw new KaanaProtocolError('Independent catalogue projection contains foreign or duplicate authority.');
      }
      seen.add(descriptor.deploymentId);
      const existing = descriptors.get(descriptor.deploymentId);
      if (existing !== undefined && canonicalScopedExecutionJson(existing) !== canonicalScopedExecutionJson(descriptor)) {
        throw new KaanaProtocolError('Independent catalogue deployment identity conflicts.');
      }
      descriptors.set(descriptor.deploymentId, descriptor);
    }
  }
  return { snapshotId: scoped.snapshotId, scopedExecutionContractVersion: SCOPED_EXECUTION_CONTRACT_VERSION,
    privateAutoExecutionContractVersion: PRIVATE_AUTO_EXECUTION_CONTRACT_VERSION,
    deployments: [...descriptors.values()].sort((a, b) => a.deploymentId.localeCompare(b.deploymentId)) };
}

const mergeCatalogueSchema = z.object({
  configuration: z.object({ snapshotId: z.string().min(1) }).passthrough(),
  models: z.array(z.object({ model: z.string().min(1), modelReference: z.string().min(1),
    listPrices: z.array(z.object({ deploymentId: z.string().min(1), provider: z.string().min(1) }).passthrough()).optional() }).passthrough()),
  deployments: kaanaPublishedDeploymentsSchema.shape.deployments,
  scopedExecutionContractVersion: z.literal(SCOPED_EXECUTION_CONTRACT_VERSION).optional(),
  privateAutoExecutionContractVersion: z.literal(PRIVATE_AUTO_EXECUTION_CONTRACT_VERSION).optional(),
}).passthrough();

export function mergeNegotiatedCatalogueReads(scopedBody: unknown, autoBody: unknown): unknown {
  const scoped = mergeCatalogueSchema.parse(scopedBody), auto = mergeCatalogueSchema.parse(autoBody);
  const merged = mergeNegotiatedDeploymentReads(
    { ...scoped, snapshotId: scoped.configuration.snapshotId },
    { ...auto, snapshotId: auto.configuration.snapshotId },
  );
  // Age and checkedAt are request-time observations; snapshot configuration is immutable.
  const { ageSeconds: _scopedAge, ...scopedConfiguration } = scoped.configuration;
  const { ageSeconds: _autoAge, ...autoConfiguration } = auto.configuration;
  if (canonicalScopedExecutionJson(scopedConfiguration) !== canonicalScopedExecutionJson(autoConfiguration) ||
    ['contractVersion', 'servesUnpinned', 'pinnedOnlyReferences'].some(key =>
      canonicalScopedExecutionJson(scoped[key] ?? null) !== canonicalScopedExecutionJson(auto[key] ?? null))) {
    throw new KaanaProtocolError('Independent catalogue snapshot configuration conflicts.');
  }
  const models = new Map<string, typeof scoped.models[number]>();
  const modelIds = new Map<string, string>();
  for (const projection of [scoped, auto]) {
    const descriptors = new Map(projection.deployments.map(row => [row.deploymentId, row]));
    const seen = new Set<string>();
    for (const model of projection.models) {
      if (seen.has(model.modelReference) || (modelIds.has(model.model) && modelIds.get(model.model) !== model.modelReference)) {
        throw new KaanaProtocolError('Independent catalogue model revision is ambiguous.');
      }
      seen.add(model.modelReference); modelIds.set(model.model, model.modelReference);
      const { listPrices = [], ...facts } = model;
      const existing = models.get(model.modelReference);
      if (existing !== undefined) {
        const { listPrices: _prices, ...oldFacts } = existing;
        if (canonicalScopedExecutionJson(facts) !== canonicalScopedExecutionJson(oldFacts)) {
          throw new KaanaProtocolError('Independent catalogue model facts conflict.');
        }
      }
      const prices = new Map<string, typeof listPrices[number]>();
      for (const price of existing?.listPrices ?? []) prices.set(price.deploymentId, price);
      const seenPrices = new Set<string>();
      for (const price of listPrices) {
        if (seenPrices.has(price.deploymentId)) throw new KaanaProtocolError('Independent catalogue repeats a price identity.');
        seenPrices.add(price.deploymentId);
        const descriptor = descriptors.get(price.deploymentId);
        if (descriptor === undefined || descriptor.modelReference !== model.modelReference || descriptor.provider !== price.provider) {
          throw new KaanaProtocolError('Independent catalogue price lacks its exact deployment descriptor.');
        }
        const previous = prices.get(price.deploymentId);
        if (previous !== undefined && canonicalScopedExecutionJson(previous) !== canonicalScopedExecutionJson(price)) {
          throw new KaanaProtocolError('Independent catalogue price identity conflicts.');
        }
        prices.set(price.deploymentId, price);
      }
      models.set(model.modelReference, { ...facts, listPrices: [...prices.values()].sort((a, b) => a.deploymentId.localeCompare(b.deploymentId)) });
    }
  }
  return { ...scoped, ...merged, models: [...models.values()].sort((a, b) => a.modelReference.localeCompare(b.modelReference)) };
}

/** `undefined` whenever the data plane is not fully configured. */
export function createHttpKaanaCatalogueReader(): KaanaCatalogueReader | undefined {
  const resolution = resolveKaanaDataPlane();
  if (resolution.status !== 'configured') return undefined;
  const { config } = resolution;
  const client = new HttpKaanaClient(config);
  return {
    attestDeployments: (deploymentIds, options) => client.attestDeployments(deploymentIds, options),
    listPublishedDeployments: (signal) => client.listPublishedDeployments(signal),
    async listModels(signal: AbortSignal): Promise<unknown> {
      const responses: unknown[] = [];
      for (const requested of catalogueNegotiations()) {
        const body = Buffer.from(JSON.stringify(requested), 'utf8');
        const timestamp = Date.now();
        const response = await fetch(`${config.baseUrl}/internal/v1/models/query`, {
          method: 'POST', body,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
            [KAANA_KEY_ID_HEADER]: config.keyId, [KAANA_TIMESTAMP_HEADER]: String(timestamp),
            [KAANA_SIGNATURE_HEADER]: signEnvelope(config.privateKey, config.keyId, timestamp, body) },
          cache: 'no-store', signal,
        });
        if (!response.ok) {
          await readBounded(response);
          throw new KaanaProtocolError(`The inference data plane refused the catalogue read with HTTP ${response.status}.`);
        }
        if (!response.headers.get('Cache-Control')?.toLowerCase().includes('no-store')) {
          throw new KaanaProtocolError('The inference catalogue projection was cacheable.');
        }
        const raw = await readBoundedStrict(response, MAX_KAANA_CATALOGUE_BYTES);
        let parsed: { scopedExecutionContractVersion?: unknown; privateAutoExecutionContractVersion?: unknown };
        try { parsed = JSON.parse(raw); } catch { throw new KaanaProtocolError('The inference data plane returned a catalogue that is not JSON.'); }
        if (parsed.privateAutoExecutionContractVersion !== requested.privateAutoExecutionContractVersion ||
          parsed.scopedExecutionContractVersion !== requested.scopedExecutionContractVersion) {
          throw new KaanaProtocolError('Missing exact independent catalogue acknowledgement.');
        }
        responses.push(parsed);
      }
      return responses.length === 1 ? responses[0] : mergeNegotiatedCatalogueReads(responses[0], responses[1]);
    },
  };
}

class HttpKaanaClient implements KaanaClient {
  private readonly config: KaanaDataPlaneConfig;

  constructor(config: KaanaDataPlaneConfig) {
    this.config = config;
  }

  async attestDeployments(
    deploymentIds: readonly string[],
    options: KaanaExecuteOptions
  ): Promise<KaanaDeploymentAttestation> {
    if (
      deploymentIds.length === 0 ||
      deploymentIds.length > MAX_KAANA_ATTESTATION_IDS ||
      new Set(deploymentIds).size !== deploymentIds.length
    ) {
      throw new KaanaProtocolError(
        `The edge attempted an invalid deployment attestation batch; expected 1..${MAX_KAANA_ATTESTATION_IDS} unique exact ids.`
      );
    }

    const body = Buffer.from(JSON.stringify({ deploymentIds: [...deploymentIds], ...(options.scopedExecutionContractVersion === undefined ? {} : { scopedExecutionContractVersion: options.scopedExecutionContractVersion }), ...(options.privateAutoExecutionContractVersion === undefined ? {} : { privateAutoExecutionContractVersion: options.privateAutoExecutionContractVersion }) }), 'utf8');
    const timestamp = Date.now();
    const response = await fetch(
      `${this.config.baseUrl}${KAANA_DEPLOYMENTS_QUERY_PATH}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Cache-Control': 'no-store',
          [KAANA_KEY_ID_HEADER]: this.config.keyId,
          [KAANA_TIMESTAMP_HEADER]: String(timestamp),
          [KAANA_SIGNATURE_HEADER]: signEnvelope(
            this.config.privateKey,
            this.config.keyId,
            timestamp,
            body
          ),
        },
        body,
        cache: 'no-store',
        signal: options.signal,
      }
    );

    if (!response.ok) {
      await readBounded(response);
      throw new KaanaProtocolError(
        `The inference data plane refused deployment attestation with HTTP ${response.status}.`
      );
    }
    if (!response.headers.get('Cache-Control')?.toLowerCase().includes('no-store')) {
      throw new KaanaProtocolError(
        'The inference data plane returned cacheable deployment identity evidence.'
      );
    }

    const raw = await readBounded(response);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new KaanaProtocolError(
        'The inference data plane returned deployment identity evidence that is not JSON.'
      );
    }
    const parsed = kaanaDeploymentAttestationSchema.safeParse(payload);
    if (!parsed.success) {
      throw new KaanaProtocolError(
        `The inference data plane returned deployment identity evidence Oxy could not read: ${issuePath(parsed.error.issues[0]?.path)}.`
      );
    }
    if (options.scopedExecutionContractVersion !== undefined && parsed.data.scopedExecutionContractVersion !== options.scopedExecutionContractVersion) {
      throw new KaanaProtocolError('The data plane did not acknowledge scoped execution 3.6.');
    }
    if (options.scopedExecutionContractVersion === undefined && parsed.data.deployments.some((row) => row.scopedExecution !== undefined)) {
      throw new KaanaProtocolError('A legacy query returned restricted deployments.');
    }
    validatePrivateAutoAttestation(parsed.data, options.privateAutoExecutionContractVersion);
    return parsed.data;
  }

  /** The whole serving snapshot: the signed empty query `{}`. */
  async listPublishedDeployments(signal: AbortSignal): Promise<KaanaDeploymentAttestation> {
    const reads: KaanaDeploymentAttestation[] = [];
    for (const negotiation of catalogueNegotiations()) reads.push(await this.readPublishedDeployments(signal, negotiation));
    return reads.length === 1 ? reads[0] : mergeNegotiatedDeploymentReads(reads[0]!, reads[1]!);
  }

  private async readPublishedDeployments(signal: AbortSignal, requested: Pick<KaanaExecuteOptions, 'scopedExecutionContractVersion' | 'privateAutoExecutionContractVersion'>): Promise<KaanaDeploymentAttestation> {
    const body = Buffer.from(JSON.stringify(requested), 'utf8');
    const timestamp = Date.now();
    const response = await fetch(`${this.config.baseUrl}${KAANA_DEPLOYMENTS_QUERY_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Cache-Control': 'no-store',
        [KAANA_KEY_ID_HEADER]: this.config.keyId,
        [KAANA_TIMESTAMP_HEADER]: String(timestamp),
        [KAANA_SIGNATURE_HEADER]: signEnvelope(this.config.privateKey, this.config.keyId, timestamp, body),
      },
      body,
      cache: 'no-store',
      signal,
    });
    if (!response.ok) {
      await readBounded(response);
      throw new KaanaProtocolError(
        `The inference data plane refused the published-deployment read with HTTP ${response.status}.`
      );
    }
    const raw = await readBoundedStrict(response, MAX_KAANA_CATALOGUE_BYTES);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new KaanaProtocolError(
        'The inference data plane returned a published-deployment list that is not JSON.'
      );
    }
    const parsed = kaanaPublishedDeploymentsSchema.safeParse(payload);
    if (!parsed.success) {
      throw new KaanaProtocolError(
        `The inference data plane returned a published-deployment list Oxy could not read: ${issuePath(parsed.error.issues[0]?.path)}.`
      );
    }
    if (parsed.data.scopedExecutionContractVersion !== requested.scopedExecutionContractVersion) {
      throw new KaanaProtocolError('The data plane did not acknowledge publication scope restrictions.');
    }
    validatePrivateAutoAttestation(parsed.data, requested.privateAutoExecutionContractVersion);
    return parsed.data;
  }

  /**
   * Forward one envelope and yield what comes back, frame by frame.
   *
   * The `finally` aborts the hop whatever ends the iteration — a terminal event,
   * a transport failure, or a consumer that stopped consuming because its own
   * client went away. That last case is the one worth stating: abandoning a
   * `for await` runs the generator's cleanup, so "the customer left" propagates
   * to Kaana and from there to the provider without the caller having to
   * remember to say so.
   */
  async *stream(
    envelope: InferenceRequest | ScopedInferenceRequest | PrivateAutoInferenceRequest,
    options: KaanaExecuteOptions
  ): AsyncGenerator<KaanaStreamFrame> {
    if (envelope.schemaVersion === 4) throw new KaanaProtocolError('Private Auto has no streaming inference path.');
    const body = kaanaEnvelopeBytes(envelope);
    const timestamp = Date.now();
    const hop = new AbortController();
    const kaanaCancellation = (): void => hop.abort();
    options.signal.addEventListener('abort', kaanaCancellation, { once: true });

    try {
      const response = await fetch(`${this.config.baseUrl}${KAANA_INFERENCE_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          [KAANA_KEY_ID_HEADER]: this.config.keyId,
          [KAANA_TIMESTAMP_HEADER]: String(timestamp),
          [KAANA_SIGNATURE_HEADER]: signEnvelope(
            this.config.privateKey,
            this.config.keyId,
            timestamp,
            body
          ),
        },
        // The SAME buffer that was hashed. Handing `fetch` the object and letting
        // it serialize would sign one encoding and send another.
        body,
        signal: hop.signal,
      });

      if (!response.ok) {
        throw await rejection(response, envelope.attribution.requestId);
      }
      if (response.body === null) {
        throw new KaanaProtocolError(
          'The inference data plane answered 200 with no body, so no event stream could be read.'
        );
      }

      for await (const frame of decodeEventStream(response.body)) {
        const decoded = readFrame(frame);
        if (decoded !== undefined) yield decoded;
      }
    } finally {
      options.signal.removeEventListener('abort', kaanaCancellation);
      hop.abort();
    }
  }

  /**
   * One non-streaming request, folded out of the same event stream.
   *
   * Kaana streams whatever the envelope's `stream` flag says, because its status
   * code has to be chosen before the failure exists. So this is not a second
   * request shape — it is the same bytes, accumulated.
   */
  async execute(
    envelope: InferenceRequest | ScopedInferenceRequest | PrivateAutoInferenceRequest,
    options: KaanaExecuteOptions
  ): Promise<KaanaCompletion> {
    if (envelope.schemaVersion === 4) {
      if (options.privateAutoExecutionContractVersion !== PRIVATE_AUTO_EXECUTION_CONTRACT_VERSION || options.scopedExecutionContractVersion !== undefined) {
        throw new KaanaProtocolError('Private Auto requires its independent negotiated contract.');
      }
      // The original parent-owned deadline covers serialization, send and response; no renewal.
      const remaining = Date.parse(envelope.privateAutoExecution.runtimeExpiresAt) - Date.now();
      if (remaining <= 0 || remaining > 1000 || options.signal.aborted) throw new KaanaProtocolError('Private Auto deadline unavailable.');
      const controller = new AbortController();
      const cancel = () => controller.abort();
      options.signal.addEventListener('abort', cancel, { once: true });
      const timeout = setTimeout(cancel, remaining);
      try { return await executeDecisions(this.config, envelope, { ...options, signal: controller.signal }); }
      finally { clearTimeout(timeout); options.signal.removeEventListener('abort', cancel); controller.abort(); }
    }
    if (envelope.input.format === 'decisions') {
      return executeDecisions(this.config, envelope, options);
    }
    return foldStream(this.stream(envelope, options));
  }
}

/**
 * One signed, non-streaming decisions request.
 *
 * Once the body may have left, a failure is one of two things and never a
 * guess between them. A typed failure from Kaana (HTTP 5xx with a contract
 * error answering this request) is preserved: its code, and its usage report
 * when the provider measured one. Anything else after send is
 * `execution_uncertain`: the provider may have run and billed, nothing was
 * measured, and the edge must not tell the client a retry is safe. A 4xx is
 * Kaana refusing the envelope before execution, as for every other format.
 */
async function executeDecisions(
  config: KaanaDataPlaneConfig,
  envelope: InferenceRequest | ScopedInferenceRequest | PrivateAutoInferenceRequest,
  options: KaanaExecuteOptions
): Promise<KaanaCompletion> {
  const requestId = envelope.attribution.requestId;
  const uncertain = (message: string): KaanaIncompleteError =>
    new KaanaIncompleteError('execution_uncertain', message);
  const body = kaanaEnvelopeBytes(envelope);
  const timestamp = Date.now();
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/internal/v1/decisions`, {
      method: 'POST',
      body,
      signal: options.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        [KAANA_KEY_ID_HEADER]: config.keyId,
        [KAANA_TIMESTAMP_HEADER]: String(timestamp),
        [KAANA_SIGNATURE_HEADER]: signEnvelope(config.privateKey, config.keyId, timestamp, body),
      },
    });
  } catch (error) {
    if (options.signal.aborted) throw error;
    // fetch cannot tell a refused connection from one cut after the body left.
    throw uncertain('The decisions request failed in transport after signing.');
  }
  if (response.status >= 400 && response.status < 500) {
    throw await rejection(response, requestId);
  }
  let raw: string;
  try {
    raw = response.ok
      ? await readBoundedStrict(response, 4 * 1024 * 1024)
      : await readBounded(response);
  } catch (error) {
    if (options.signal.aborted) throw error;
    throw uncertain('The decisions response was cut or oversized.');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    if (!response.ok) logDecisionsFailure(response, requestId, undefined);
    throw uncertain(`The decisions response (HTTP ${response.status}) was not readable JSON.`);
  }
  if (!response.ok) {
    const typed = decisionFailureSchema.safeParse(payload);
    const bare = typed.success ? undefined : inferenceErrorSchema.safeParse(payload);
    const failure = typed.success ? typed.data.error : bare?.success ? bare.data : undefined;
    logDecisionsFailure(response, requestId, failure?.code);
    if (failure === undefined || failure.requestId !== requestId) {
      throw uncertain(`The decisions data plane answered HTTP ${response.status} without a typed failure for this request.`);
    }
    const usage = typed.success ? typed.data.usage : undefined;
    throw new KaanaIncompleteError('terminal_error', failure.message, {
      failure,
      ...(usage === undefined ? {} : { usage: { kind: 'report', report: usage } }),
    });
  }
  const parsed = decisionResultSchema.safeParse(payload);
  if (
    !parsed.success ||
    envelope.input.format !== 'decisions' ||
    parsed.data.requestId !== requestId ||
    envelope.target.kind !== 'model' ||
    parsed.data.model !== envelope.target.modelReference ||
    parsed.data.model !== parsed.data.usage.resolvedModelReference ||
    !decisionAnswersMatch(envelope.input.decisions, parsed.data.data)
  ) {
    throw new KaanaProtocolError('Invalid or mismatched decisions result.');
  }
  return {
    output: [],
    decisions: parsed.data.data,
    finishReason: 'stop',
    usage: parsed.data.usage,
  };
}

/** Log a decisions 5xx with its typed code, never its message or body. */
function logDecisionsFailure(
  response: Response,
  requestId: string,
  upstreamCode: string | undefined
): void {
  logger.error(
    'inference.kaana.decisions_failed',
    new Error(`the inference data plane answered HTTP ${response.status}`),
    {
      component: 'inference-kaana',
      requestId,
      status: response.status,
      ...(upstreamCode === undefined ? {} : { upstreamCode }),
    }
  );
}

/* -------------------------------------------------------------------------- */
/*  Folding a stream into a completion                                        */
/* -------------------------------------------------------------------------- */

/**
 * Accumulate a stream into the one value a non-streaming caller wants.
 *
 * Not exported: it is exercised end to end, through `execute`, against a stub
 * data plane that verifies the signature — which is stronger evidence than a unit
 * test over a hand-built frame list, because it also proves the DECODER produced
 * the frames the fold was given.
 *
 * ## What a fold cannot carry, stated rather than discovered
 *
 * `reasoning` and `refusal` deltas are DROPPED. `inferenceContentPartSchema` has
 * `text`, `image`, `audio` and `file` and no member for either, so there is
 * nowhere in an {@link InferenceMessage} to put them — and inventing a text part
 * would render a model's private reasoning to the customer as its answer, which
 * the contract's own channel comment calls a product bug. A refusal survives as
 * `finishReason: 'refusal'`; its explanatory text does not. Streaming callers get
 * both channels in full, because there the events are the response.
 *
 * Tool calls attach to output 0: the stream's `tool_call` event carries a
 * `toolCallId` and no output index, so there is no value to distribute them by.
 */
async function foldStream(
  frames: AsyncIterable<KaanaStreamFrame>
): Promise<KaanaCompletion> {
  const texts = new Map<number, string>();
  const transcripts = new Map<number, string>();
  const audio = new Map<number, { mediaType: string; chunks: Buffer[] }>();
  let audioBytes = 0;
  const toolCalls = new Map<string, { name: string; args: string }>();
  let generationId: string | undefined;
  let finishReason: InferenceFinishReason | undefined;
  let report: NormalizedUsageReport | undefined;
  let partial:
    | {
        requestId: string;
        deploymentId: string;
        units: readonly UsageQuantity[];
        usageSource: UsageSource;
      }
    | undefined;
  let terminalFailure: InferenceError | undefined;
  const routeSwitchEvents: InferenceStreamRouteSwitchEvent[] = [];

  // The `catch` below is the difference between a partial settlement and a full
  // refund. An upstream cut off after two hundred tokens throws out of this
  // iteration, and without it the usage the stream DID report would be lost with
  // the stack — so a customer's charge would depend on whether the connection
  // happened to close cleanly.
  //
  // A `KaanaProtocolError` or `KaanaEnvelopeRejectedError` is rethrown unchanged:
  // those are framing or signing faults on Oxy's own side of the wire, where the
  // units read so far are as suspect as the frame that failed to parse, so the
  // conservative direction is the full refund.
  try {
    for await (const frame of frames) {
      if (frame.kind === 'usage') {
        report = frame.usage;
        continue;
      }

      const event = frame.event;
      switch (event.type) {
        case 'start':
          generationId = event.generationId ?? generationId;
          break;
        case 'delta':
          if (event.channel === 'output_text') {
            texts.set(event.outputIndex, (texts.get(event.outputIndex) ?? '') + event.text);
          } else if (event.channel === 'output_audio_transcript') {
            transcripts.set(
              event.outputIndex,
              (transcripts.get(event.outputIndex) ?? '') + event.text
            );
          }
          break;
        case 'audio': {
          const chunk = Buffer.from(event.data, 'base64');
          const existing = audio.get(event.outputIndex);
          audioBytes += chunk.length;
          // Re-encoding catches non-canonical padding bits the contract regex admits.
          if (chunk.toString('base64') !== event.data || audioBytes > MAX_INFERENCE_AUDIO_BYTES ||
              (existing !== undefined && existing.mediaType !== event.mediaType)) {
            throw new KaanaProtocolError('The inference data plane sent invalid or oversized audio.');
          }
          if (existing === undefined) {
            audio.set(event.outputIndex, { mediaType: event.mediaType, chunks: [chunk] });
          } else {
            existing.chunks.push(chunk);
          }
          break;
        }
        case 'tool_call': {
          const existing = toolCalls.get(event.toolCallId) ?? { name: '', args: '' };
          toolCalls.set(event.toolCallId, {
            name: event.name ?? existing.name,
            args: existing.args + (event.argumentsDelta ?? ''),
          });
          break;
        }
        case 'usage':
          partial = {
            requestId: event.requestId,
            deploymentId: event.deploymentId,
            units: event.units,
            usageSource: event.usageSource,
          };
          break;
        case 'route_switch':
          // KEPT, not counted. `usage.routeSwitches` is the metric; this is the
          // notice, and a count cannot be turned back into one. A non-streaming
          // customer never sees the stream, so this list is the only way the
          // switch reaches `inference_route_switch_events` on that dialect.
          //
          // Bounded by the contract: `routeSwitches` is capped at 100, and a data
          // plane reporting more events than that is already refused by the
          // report's own schema.
          routeSwitchEvents.push(event);
          break;
        case 'error':
          // Terminal. Kept rather than thrown here so a usage report that follows
          // it — Kaana writes the report after the executor returns — is still
          // collected and can be settled exactly.
          terminalFailure = event.error;
          break;
        case 'done':
          generationId = event.generationId ?? generationId;
          finishReason = event.finishReason;
          break;
      }
    }
  } catch (error) {
    if (error instanceof KaanaProtocolError || error instanceof KaanaEnvelopeRejectedError) {
      throw error;
    }
    const cut = usageEvidence(report, partial);
    throw new KaanaIncompleteError(
      'stream_truncated',
      'The inference data plane stopped responding before the request completed.',
      cut === undefined ? {} : { usage: cut }
    );
  }

  const evidence = usageEvidence(report, partial);

  if (terminalFailure !== undefined) {
    throw new KaanaIncompleteError(
      'terminal_error',
      'The inference data plane ended the request with an error.',
      {
        failure: terminalFailure,
        ...(evidence === undefined ? {} : { usage: evidence }),
      }
    );
  }

  if (finishReason === undefined) {
    throw new KaanaIncompleteError(
      'stream_truncated',
      'The inference data plane ended the stream without a terminal event.',
      evidence === undefined ? {} : { usage: evidence }
    );
  }

  if (report === undefined) {
    // The generation finished and cannot be charged exactly. Refused rather than
    // served for free-and-silently: `KaanaCompletion.usage` is the record the
    // ledger settles from, and the only way to return one here would be to
    // fabricate it.
    throw new KaanaIncompleteError(
      'usage_missing',
      'The inference data plane completed the request without a usage report.',
      evidence === undefined ? {} : { usage: evidence }
    );
  }

  const folded = foldedOutput(texts, toolCalls, audio, transcripts);
  return {
    ...(generationId === undefined ? {} : { generationId }),
    output: folded.output,
    ...(transcripts.size === 0 ? {} : { outputAudioTranscripts: folded.transcripts }),
    finishReason,
    usage: report,
    routeSwitchEvents,
  };
}

/** The report when there is one, else the units the stream did report. */
function usageEvidence(
  report: NormalizedUsageReport | undefined,
  partial:
    | {
        requestId: string;
        deploymentId: string;
        units: readonly UsageQuantity[];
        usageSource: UsageSource;
      }
    | undefined
): KaanaUsageEvidence | undefined {
  if (report !== undefined) return { kind: 'report', report };
  if (partial !== undefined) {
    return { kind: 'partial', ...partial };
  }
  return undefined;
}

/**
 * The accumulated text and tool calls as normalized assistant messages.
 *
 * One message per output index, in index order, so a multi-output response is
 * rendered in the order the provider produced it rather than in `Map` insertion
 * order. A response that was nothing but tool calls still produces one message,
 * because an assistant turn that only calls a tool is a real and common message,
 * and so does one that produced nothing visible at all (see below).
 */
function foldedOutput(
  texts: ReadonlyMap<number, string>,
  toolCalls: ReadonlyMap<string, { name: string; args: string }>,
  audio: ReadonlyMap<number, { mediaType: string; chunks: Buffer[] }>,
  transcripts: ReadonlyMap<number, string>
): { output: InferenceMessage[]; transcripts: (string | null)[] } {
  const calls: InferenceToolCall[] = [...toolCalls.entries()].map(([id, call]) => ({
    id,
    name: call.name,
    arguments: call.args,
  }));

  const indexes = [...new Set([...texts.keys(), ...audio.keys(), ...transcripts.keys()])].sort(
    (left, right) => left - right
  );
  if (indexes.length === 0) {
    // A completed generation is always ONE assistant turn, even when it
    // produced no visible content: a reasoning model whose whole output budget
    // went to reasoning finishes `length` with nothing but reasoning deltas,
    // which this fold drops. Folding that to `output: []` made every dialect
    // render an answer with no choice at all (`choices: []`), which an
    // OpenAI-compatible client reads as a malformed response rather than as a
    // truncated one.
    return {
      output: [
        { role: 'assistant', content: [], ...(calls.length === 0 ? {} : { toolCalls: calls }) },
      ],
      transcripts: [null],
    };
  }

  const output = indexes.map((index, position) => {
    const text = texts.get(index);
    const clip = audio.get(index);
    return {
      role: 'assistant' as const,
      content: [
        ...(text === undefined ? [] : [{ type: 'text' as const, text }]),
        ...(clip === undefined ? [] : [{ type: 'audio' as const, source: {
          kind: 'inline' as const,
          mediaType: clip.mediaType,
          data: Buffer.concat(clip.chunks).toString('base64'),
        } }]),
      ],
      ...(position === 0 && calls.length > 0 ? { toolCalls: calls } : {}),
    };
  });
  return { output, transcripts: indexes.map((index) => transcripts.get(index) ?? null) };
}

/* -------------------------------------------------------------------------- */
/*  Reading the wire                                                          */
/* -------------------------------------------------------------------------- */

/** One decoded SSE frame: its `event:` name and its joined `data:` lines. */
interface RawFrame {
  readonly name: string;
  readonly data: string;
}

/**
 * Read one frame into the shape it declares itself to be.
 *
 * An unknown frame NAME is ignored: the name is Kaana's transport framing rather
 * than part of the contract, so a future frame carrying something this build does
 * not consume is additive. A known frame whose payload the published schema
 * rejects is a {@link KaanaProtocolError} — that is the contract's versioning
 * rule, and for a usage report the stake is a charge.
 */
function readFrame(frame: RawFrame): KaanaStreamFrame | undefined {
  if (frame.name !== FRAME_STREAM_EVENT && frame.name !== FRAME_USAGE_REPORT) {
    return undefined;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(frame.data);
  } catch {
    throw new KaanaProtocolError(
      `The inference data plane sent a ${frame.name} frame that is not JSON.`
    );
  }

  if (frame.name === FRAME_USAGE_REPORT) {
    const parsed = normalizedUsageReportSchema.safeParse(payload);
    if (!parsed.success) {
      throw new KaanaProtocolError(
        `The inference data plane sent a usage report Oxy could not read: ${issuePath(parsed.error.issues[0]?.path)}.`
      );
    }
    return { kind: 'usage', usage: parsed.data };
  }

  const parsed = inferenceStreamEventSchema.safeParse(payload);
  if (!parsed.success) {
    throw new KaanaProtocolError(
      `The inference data plane sent a stream event Oxy could not read: ${issuePath(parsed.error.issues[0]?.path)}.`
    );
  }
  return { kind: 'event', event: parsed.data };
}

function issuePath(path: readonly (string | number)[] | undefined): string {
  return path === undefined || path.length === 0 ? 'unknown field' : path.join('.');
}

/**
 * Decode an SSE body into frames as they arrive.
 *
 * Written to the SSE specification rather than to Kaana's exact output —
 * multiple `data:` lines in one event concatenate, comment lines are ignored, a
 * trailing event with no blank line still counts — because the thing on the other
 * end of this stream may one day be a proxy that reframes rather than Kaana
 * itself. The last of those three matters most: an upstream cut off mid-stream
 * has usually already sent output worth counting, and discarding an unterminated
 * frame would lose the usage a partial settlement depends on.
 */
async function* decodeEventStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<RawFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let pending = '';
  let name = '';
  let data: string[] = [];
  let accumulated = 0;

  const dispatch = (): RawFrame | undefined => {
    if (data.length === 0 && name.length === 0) return undefined;
    const frame: RawFrame = { name, data: data.join('\n') };
    name = '';
    data = [];
    accumulated = 0;
    return frame;
  };

  const consume = (raw: string): RawFrame | undefined => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length === 0) return dispatch();
    // A comment, commonly a keep-alive. Not an event.
    if (line.startsWith(':')) return undefined;
    if (line.startsWith('data:')) {
      const value = line.slice('data:'.length);
      const text = value.startsWith(' ') ? value.slice(1) : value;
      accumulated += text.length;
      if (accumulated > MAX_KAANA_EVENT_CHARACTERS) {
        throw new KaanaProtocolError(
          `The inference data plane sent an event over ${MAX_KAANA_EVENT_CHARACTERS} characters.`
        );
      }
      data.push(text);
      return undefined;
    }
    if (line.startsWith('event:')) {
      name = line.slice('event:'.length).trim();
      return undefined;
    }
    // `id:`, `retry:` and unknown fields carry nothing this client reads.
    return undefined;
  };

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    pending += decoder.decode(chunk.value, { stream: true });
    if (pending.length > MAX_KAANA_EVENT_CHARACTERS) {
      throw new KaanaProtocolError(
        `The inference data plane sent a line over ${MAX_KAANA_EVENT_CHARACTERS} characters with no frame boundary.`
      );
    }

    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const frame = consume(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      if (frame !== undefined) yield frame;
      newline = pending.indexOf('\n');
    }
  }

  pending += decoder.decode();
  if (pending.length > 0) {
    const frame = consume(pending);
    if (frame !== undefined) yield frame;
  }
  const trailing = dispatch();
  if (trailing !== undefined) yield trailing;
}

/**
 * What a non-`200` means, read from a bounded prefix of its body.
 *
 * A `4xx` is Oxy's own envelope being refused and becomes
 * {@link KaanaEnvelopeRejectedError}; a `5xx` is the data plane or something in
 * front of it being unavailable, which is a transport failure and retryable, so
 * it stays an ordinary `Error` and lands in the edge's `provider_error` arm.
 *
 * Kaana's error body is the contract's own error shape, so `code` is read when it
 * is there — for the LOG only. It never becomes the customer's code: telling a
 * customer `authentication_failed` because Oxy's signing key was rejected would
 * point them at their own API key.
 */
async function rejection(response: Response, requestId: string): Promise<Error> {
  const body = await readBounded(response);
  const upstreamCode = upstreamErrorCode(body);

  logger.error(
    'inference.kaana.rejected_envelope',
    new Error(`the inference data plane answered HTTP ${response.status}`),
    {
      component: 'inference-kaana',
      requestId,
      status: response.status,
      ...(upstreamCode === undefined ? {} : { upstreamCode }),
      // Kaana mints its own id for a request it rejected before trusting the
      // body, so this is the id in ITS logs and the only way to join the two.
      ...(response.headers.get('X-Oxy-Request-Id') === null
        ? {}
        : { kaanaRequestId: response.headers.get('X-Oxy-Request-Id') }),
    }
  );

  if (response.status >= 500) {
    return new Error(`The inference data plane is unavailable (HTTP ${response.status}).`);
  }
  return new KaanaEnvelopeRejectedError(response.status, upstreamCode);
}

/** The `code` of a contract error body, when the body is one. */
function upstreamErrorCode(body: string): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null) return undefined;
  const code = (payload as { code?: unknown }).code;
  const parsed = inferenceErrorCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The whole body as text, refusing (rather than truncating) one larger than
 * `limit` characters: a truncated catalogue would parse as nothing, or worse,
 * as a shorter catalogue whose missing models the sync would retire.
 */
async function readBoundedStrict(response: Response, limit: number): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
    if (text.length > limit) {
      await reader.cancel();
      throw new KaanaProtocolError(`The inference data plane returned a catalogue over ${limit} characters.`);
    }
  }
  return text + decoder.decode();
}

/** At most {@link MAX_KAANA_REJECTION_BYTES} of a response body, as text. */
async function readBounded(response: Response): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
    if (text.length >= MAX_KAANA_REJECTION_BYTES) {
      await reader.cancel();
      return text.slice(0, MAX_KAANA_REJECTION_BYTES);
    }
  }
  return text + decoder.decode();
}

/** Validate without changing legacy bytes; scoped input hashes cover the actual JSON wire. */
export function kaanaEnvelopeBytes(envelope: InferenceRequest | ScopedInferenceRequest | PrivateAutoInferenceRequest): Buffer<ArrayBuffer> {
  if (envelope.schemaVersion === 4) {
    const validated = privateAutoInferenceRequestSchema.parse(envelope);
    const inputSha256 = createHash('sha256').update(canonicalScopedExecutionJson(validated.input), 'utf8').digest('hex');
    if (inputSha256 !== validated.privateAutoExecution.inputSha256) throw new KaanaProtocolError('Private Auto input hash mismatch.');
    return Buffer.from(canonicalScopedExecutionJson(JSON.parse(JSON.stringify(validated)) as unknown), 'utf8');
  }
  if (envelope.schemaVersion === 3) {
    const validated = scopedInferenceRequestSchema.parse(envelope);
    const wire = JSON.parse(JSON.stringify(validated)) as unknown;
    return Buffer.from(canonicalScopedExecutionJson(wire), 'utf8');
  }
  inferenceRequestSchema.parse(envelope);
  return Buffer.from(JSON.stringify(envelope), 'utf8');
}
