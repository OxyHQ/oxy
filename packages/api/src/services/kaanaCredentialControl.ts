import { createHash, sign, timingSafeEqual } from 'node:crypto';
import { kaanaCredentialHandleSchema } from '@oxyhq/contracts';
import { z } from 'zod';
import {
  resolveKaanaCredentialControl,
  type KaanaCredentialControlConfig,
} from '../config/kaanaCredentialControl';
import type { ProviderConnectionActor } from '../db/schema/inferenceProviderConnectionAuditEvents';
import type { ProviderConnectionEnvironment } from '../db/schema/inferenceProviderConnections';

const MUTATION_PATH = '/internal/v1/customer-provider-credentials/mutations';
const SIGNATURE_DOMAIN = 'oxy-kaana-credential-control:v1';
const KEY_ID_HEADER = 'X-Oxy-Kaana-Key-Id';
const TIMESTAMP_HEADER = 'X-Oxy-Kaana-Timestamp';
const SIGNATURE_HEADER = 'X-Oxy-Kaana-Signature';
const MAX_RESPONSE_BYTES = 16 * 1024;

const referenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    credentialHandle: kaanaCredentialHandleSchema,
    revision: z.number().int().positive().safe(),
  })
  .strict();

export interface KaanaCredentialReference {
  readonly credentialHandle: string;
  readonly revision: number;
}

export interface CredentialIdentity {
  readonly provider: string;
  readonly ownerAccountId: string;
  readonly connectionId: string;
  readonly environment: ProviderConnectionEnvironment;
}

/** Runtime-enforced redaction wrapper for request-only customer plaintext. */
export class ProviderCredentialValue {
  readonly #value: string;

  constructor(value: string) {
    if (value.length === 0 || Buffer.byteLength(value, 'utf8') > 4096 || /[\r\n]/.test(value)) {
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

export interface KaanaCredentialControl {
  create(
    input: CredentialIdentity & {
      readonly secret: ProviderCredentialValue;
      readonly actor: ProviderConnectionActor;
    },
  ): Promise<KaanaCredentialReference>;
  rotate(
    input: CredentialIdentity &
      KaanaCredentialReference & {
        readonly secret: ProviderCredentialValue;
        readonly actor: ProviderConnectionActor;
      },
  ): Promise<KaanaCredentialReference>;
  revoke(
    input: CredentialIdentity &
      KaanaCredentialReference & {
        readonly actor: ProviderConnectionActor;
      },
  ): Promise<KaanaCredentialReference>;
}

export class KaanaCredentialControlUnavailableError extends Error {
  readonly code = 'kaana_credential_control_unavailable' as const;
}

export class KaanaCredentialConflictError extends Error {
  readonly code = 'credential_conflict' as const;
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

  async create(
    input: CredentialIdentity & {
      readonly secret: ProviderCredentialValue;
      readonly actor: ProviderConnectionActor;
    },
  ): Promise<KaanaCredentialReference> {
    return this.mutate(
      {
        schemaVersion: 1,
        action: 'create',
        ...identityFields(input),
        operationActor: actorName(input.actor),
        secretBase64: Buffer.from(input.secret.reveal(), 'utf8').toString('base64'),
      },
      true,
    );
  }

  async rotate(
    input: CredentialIdentity &
      KaanaCredentialReference & {
        readonly secret: ProviderCredentialValue;
        readonly actor: ProviderConnectionActor;
      },
  ): Promise<KaanaCredentialReference> {
    return this.mutate({
      schemaVersion: 1,
      action: 'rotate',
      ...identityFields(input),
      credentialHandle: input.credentialHandle,
      expectedRevision: input.revision,
      operationActor: actorName(input.actor),
      secretBase64: Buffer.from(input.secret.reveal(), 'utf8').toString('base64'),
    });
  }

  async revoke(
    input: CredentialIdentity &
      KaanaCredentialReference & { readonly actor: ProviderConnectionActor },
  ): Promise<KaanaCredentialReference> {
    return this.mutate({
      schemaVersion: 1,
      action: 'revoke',
      ...identityFields(input),
      credentialHandle: input.credentialHandle,
      expectedRevision: input.revision,
      operationActor: actorName(input.actor),
    });
  }

  private async mutate(
    payload: object,
    acceptCreateConflict = false,
  ): Promise<KaanaCredentialReference> {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const timestamp = Date.now();
    const signingInput = kaanaCredentialControlSigningInput(this.config.keyId, timestamp, body);
    const signature = sign(null, signingInput, this.config.privateKey).toString('base64');

    const response = await fetch(`${this.config.baseUrl}${MUTATION_PATH}`, {
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
    const responseBody = await readBoundedBody(response);
    if (response.ok || (acceptCreateConflict && response.status === 409)) {
      const parsed = referenceSchema.safeParse(JSON.parse(responseBody));
      if (parsed.success) {
        return {
          credentialHandle: parsed.data.credentialHandle,
          revision: parsed.data.revision,
        };
      }
    }
    if (response.status === 409)
      throw new KaanaCredentialConflictError('Kaana refused the revision');
    throw new Error(`Kaana credential control refused the mutation with HTTP ${response.status}`);
  }
}

export function kaanaCredentialControlSigningInput(
  keyId: string,
  timestamp: number,
  body: Buffer,
): Buffer {
  const digest = createHash('sha256').update(body).digest('hex');
  return Buffer.from([SIGNATURE_DOMAIN, keyId, String(timestamp), digest].join('\n'), 'utf8');
}

function identityFields(input: CredentialIdentity): CredentialIdentity {
  return {
    provider: input.provider,
    ownerAccountId: input.ownerAccountId,
    connectionId: input.connectionId,
    environment: input.environment,
  };
}

function actorName(actor: ProviderConnectionActor): string {
  return actor.kind === 'user' ? `user:${actor.userId}` : actor.kind;
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
