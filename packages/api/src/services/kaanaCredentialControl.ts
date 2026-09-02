import { createHash, sign, timingSafeEqual } from 'node:crypto';
import {
  kaanaCredentialCreateMutationSchema,
  kaanaCredentialCreateOutcomeRequestSchema,
  kaanaCredentialMutationSchema,
  kaanaCredentialOutcomeRequestSchema,
  kaanaCredentialOutcomeSchema,
  kaanaCredentialRevokeMutationSchema,
  kaanaCredentialRevokeOutcomeRequestSchema,
  kaanaCredentialRotateMutationSchema,
  kaanaCredentialRotateOutcomeRequestSchema,
  type KaanaCredentialIdentity,
  type KaanaCredentialMutation,
  type KaanaCredentialOutcome,
  type KaanaCredentialOutcomeRequest,
} from '@oxyhq/contracts';
import {
  resolveKaanaCredentialControl,
  type KaanaCredentialControlConfig,
} from '../config/kaanaCredentialControl';

const MUTATION_PATH = '/internal/v1/customer-provider-credentials/mutations';
const OUTCOME_PATH = '/internal/v1/customer-provider-credentials/outcomes';
const SIGNATURE_DOMAIN = 'oxy-kaana-credential-control:v1';
const KEY_ID_HEADER = 'X-Oxy-Kaana-Key-Id';
const TIMESTAMP_HEADER = 'X-Oxy-Kaana-Timestamp';
const SIGNATURE_HEADER = 'X-Oxy-Kaana-Signature';
const MAX_RESPONSE_BYTES = 16 * 1024;

/** Runtime-enforced redaction wrapper for request-only customer plaintext. */
export class ProviderCredentialValue {
  readonly #value: string;

  constructor(value: string) {
    if (
      value.trim().length === 0 ||
      Buffer.byteLength(value, 'utf8') > 4096 ||
      /[\r\n]/.test(value)
    ) {
      throw new Error('a provider credential must be one non-empty line of at most 4096 bytes');
    }
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  prefix(): string {
    return this.#value.slice(0, 12);
  }

  toString(): string {
    return '[redacted provider credential]';
  }

  toJSON(): string {
    return '[redacted provider credential]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[redacted provider credential]';
  }
}

export function fingerprintProviderCredential(secret: ProviderCredentialValue): string {
  return createHash('sha256').update(secret.reveal(), 'utf8').digest('hex');
}

export function providerCredentialFingerprintsMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

interface KaanaCredentialOperationBase extends KaanaCredentialIdentity {
  readonly operationId: string;
  readonly operationActor: string;
}

export interface KaanaCredentialCreateOperation extends KaanaCredentialOperationBase {
  readonly secret: ProviderCredentialValue;
  readonly secretSha256: string;
}

export interface KaanaCredentialRotateOperation extends KaanaCredentialCreateOperation {
  readonly credentialHandle: string;
  readonly expectedRevision: number;
}

export interface KaanaCredentialRevokeOperation extends KaanaCredentialOperationBase {
  readonly credentialHandle: string;
  readonly expectedRevision: number;
}

export interface KaanaCredentialControl {
  create(input: KaanaCredentialCreateOperation): Promise<KaanaCredentialOutcome>;
  rotate(input: KaanaCredentialRotateOperation): Promise<KaanaCredentialOutcome>;
  revoke(input: KaanaCredentialRevokeOperation): Promise<KaanaCredentialOutcome>;
  outcome(input: KaanaCredentialOutcomeRequest): Promise<KaanaCredentialOutcome>;
}

export class KaanaCredentialControlUnavailableError extends Error {
  readonly code = 'kaana_credential_control_unavailable' as const;
}

export class KaanaCredentialConflictError extends Error {
  readonly code = 'credential_conflict' as const;
}

export class KaanaCredentialOutcomeUnavailableError extends Error {
  readonly code = 'credential_outcome_unavailable' as const;
}

export function requireKaanaCredentialControl(): KaanaCredentialControl {
  const resolution = resolveKaanaCredentialControl();
  if (resolution.status !== 'configured') {
    throw new KaanaCredentialControlUnavailableError(
      'Kaana credential custody is not fully configured; BYOK mutations are disabled',
    );
  }
  return new HttpKaanaCredentialControl(resolution.config);
}

export class HttpKaanaCredentialControl implements KaanaCredentialControl {
  constructor(private readonly config: KaanaCredentialControlConfig) {}

  async create(input: KaanaCredentialCreateOperation): Promise<KaanaCredentialOutcome> {
    requireMatchingFingerprint(input.secret, input.secretSha256);
    const outcomeRequest = kaanaCredentialCreateOutcomeRequestSchema.parse({
      schemaVersion: 1,
      action: 'create',
      operationId: input.operationId,
      ...identityFields(input),
      secretSha256: input.secretSha256,
    });
    return this.mutate(
      kaanaCredentialCreateMutationSchema.parse({
        schemaVersion: 1,
        action: 'create',
        operationId: input.operationId,
        ...identityFields(input),
        operationActor: input.operationActor,
        secretBase64: Buffer.from(input.secret.reveal(), 'utf8').toString('base64'),
      }),
      outcomeRequest,
    );
  }

  async rotate(input: KaanaCredentialRotateOperation): Promise<KaanaCredentialOutcome> {
    requireMatchingFingerprint(input.secret, input.secretSha256);
    const outcomeRequest = kaanaCredentialRotateOutcomeRequestSchema.parse({
      schemaVersion: 1,
      action: 'rotate',
      operationId: input.operationId,
      ...identityFields(input),
      secretSha256: input.secretSha256,
      credentialHandle: input.credentialHandle,
      expectedRevision: input.expectedRevision,
    });
    return this.mutate(
      kaanaCredentialRotateMutationSchema.parse({
        schemaVersion: 1,
        action: 'rotate',
        operationId: input.operationId,
        ...identityFields(input),
        operationActor: input.operationActor,
        credentialHandle: input.credentialHandle,
        expectedRevision: input.expectedRevision,
        secretBase64: Buffer.from(input.secret.reveal(), 'utf8').toString('base64'),
      }),
      outcomeRequest,
    );
  }

  async revoke(input: KaanaCredentialRevokeOperation): Promise<KaanaCredentialOutcome> {
    const outcomeRequest = kaanaCredentialRevokeOutcomeRequestSchema.parse({
      schemaVersion: 1,
      action: 'revoke',
      operationId: input.operationId,
      ...identityFields(input),
      credentialHandle: input.credentialHandle,
      expectedRevision: input.expectedRevision,
    });
    return this.mutate(
      kaanaCredentialRevokeMutationSchema.parse({
        schemaVersion: 1,
        action: 'revoke',
        operationId: input.operationId,
        ...identityFields(input),
        operationActor: input.operationActor,
        credentialHandle: input.credentialHandle,
        expectedRevision: input.expectedRevision,
      }),
      outcomeRequest,
    );
  }

  async outcome(input: KaanaCredentialOutcomeRequest): Promise<KaanaCredentialOutcome> {
    const exactRequest = kaanaCredentialOutcomeRequestSchema.parse(input);
    let response: SignedResponse;
    try {
      response = await this.postSigned(OUTCOME_PATH, exactRequest);
    } catch (error) {
      // Transport errors can contain request/response internals. The public
      // reconciliation state is the only safe information to propagate.
      void error;
      throw new KaanaCredentialOutcomeUnavailableError(
        'Kaana credential outcome could not be read exactly',
      );
    }
    if (response.status === 404) {
      throw new KaanaCredentialOutcomeUnavailableError(
        'Kaana has no outcome for that exact operation identity',
      );
    }
    const outcome = parseExactOutcome(response.body, exactRequest);
    if ((response.status === 200 || response.status === 409) && outcome?.status === 'conflict') {
      throw new KaanaCredentialConflictError('Kaana recorded a credential operation conflict');
    }
    if (response.status !== 200) {
      throw new KaanaCredentialOutcomeUnavailableError(
        'Kaana credential outcome could not be read exactly',
      );
    }
    if (outcome === undefined) {
      throw new KaanaCredentialOutcomeUnavailableError(
        'Kaana credential outcome did not match the persisted operation',
      );
    }
    return outcome;
  }

  private async mutate(
    payload: KaanaCredentialMutation,
    outcomeRequest: KaanaCredentialOutcomeRequest,
  ): Promise<KaanaCredentialOutcome> {
    let response: SignedResponse | undefined;
    try {
      response = await this.postSigned(MUTATION_PATH, kaanaCredentialMutationSchema.parse(payload));
    } catch (error) {
      void error;
      return this.outcome(outcomeRequest);
    }

    const exact = parseExactOutcome(response.body, outcomeRequest);
    if (response.status === 409 && exact?.status === 'conflict') {
      throw new KaanaCredentialConflictError('Kaana recorded a credential operation conflict');
    }
    if (response.status >= 200 && response.status < 300 && exact?.status === 'applied') {
      return exact;
    }

    // A missing, malformed or mismatched response never proves that the
    // transaction did not commit. Ask the signed exact-outcome route with the
    // already persisted operation id instead of retrying with a new one.
    return this.outcome(outcomeRequest);
  }

  private async postSigned(path: string, payload: object): Promise<SignedResponse> {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    try {
      const timestamp = Date.now();
      const signingInput = kaanaCredentialControlSigningInput(this.config.keyId, timestamp, body);
      const signature = sign(null, signingInput, this.config.privateKey).toString('base64');
      const response = await fetch(`${this.config.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [KEY_ID_HEADER]: this.config.keyId,
          [TIMESTAMP_HEADER]: String(timestamp),
          [SIGNATURE_HEADER]: `v1=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: await readBoundedBody(response) };
    } finally {
      body.fill(0);
    }
  }
}

interface SignedResponse {
  readonly status: number;
  readonly body: string;
}

export function kaanaCredentialControlSigningInput(
  keyId: string,
  timestamp: number,
  body: Buffer,
): Buffer {
  const digest = createHash('sha256').update(body).digest('hex');
  return Buffer.from([SIGNATURE_DOMAIN, keyId, String(timestamp), digest].join('\n'), 'utf8');
}

function identityFields(input: KaanaCredentialIdentity): KaanaCredentialIdentity {
  return {
    provider: input.provider,
    ownerAccountId: input.ownerAccountId,
    connectionId: input.connectionId,
    environment: input.environment,
  };
}

function requireMatchingFingerprint(secret: ProviderCredentialValue, expected: string): void {
  if (!providerCredentialFingerprintsMatch(fingerprintProviderCredential(secret), expected)) {
    throw new Error('the persisted provider credential fingerprint does not match the mutation');
  }
}

function parseExactOutcome(
  body: string,
  request: KaanaCredentialOutcomeRequest,
): KaanaCredentialOutcome | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch (error) {
    void error;
    return undefined;
  }
  const parsed = kaanaCredentialOutcomeSchema.safeParse(decoded);
  if (
    !parsed.success ||
    parsed.data.operationId !== request.operationId ||
    parsed.data.action !== request.action
  ) {
    return undefined;
  }
  if (parsed.data.status === 'conflict') return parsed.data;
  if (request.action === 'create') {
    return parsed.data.revision === 1 ? parsed.data : undefined;
  }
  return parsed.data.credentialHandle === request.credentialHandle &&
    parsed.data.revision === request.expectedRevision + 1
    ? parsed.data
    : undefined;
}

async function readBoundedBody(response: Response): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel('Kaana response exceeded its bound');
        throw new Error('Kaana response exceeded its bound');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
