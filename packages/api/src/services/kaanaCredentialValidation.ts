import { createHash, sign } from 'node:crypto';
import {
  kaanaCredentialValidationOutcomeSchema,
  kaanaCredentialValidationTaskSchema,
  type KaanaCredentialValidationTask,
} from '@oxyhq/contracts';
import {
  resolveKaanaDataPlane,
  type KaanaDataPlaneConfig,
} from '../config/kaanaDataPlane';

const VALIDATION_PATH = '/internal/v1/customer-provider-credentials/validations';
const SIGNATURE_DOMAIN = 'oxy-kaana-credential-validation:v1';
const MAX_RESPONSE_BYTES = 16 * 1024;
const KEY_ID_HEADER = 'X-Oxy-Kaana-Key-Id';
const TIMESTAMP_HEADER = 'X-Oxy-Kaana-Timestamp';
const SIGNATURE_HEADER = 'X-Oxy-Kaana-Signature';

export interface KaanaCredentialValidationDispatcher {
  dispatch(task: KaanaCredentialValidationTask): Promise<void>;
}

export class KaanaCredentialValidationUnavailableError extends Error {
  readonly code = 'kaana_credential_validation_unavailable' as const;
}

export function requireKaanaCredentialValidationDispatcher(): KaanaCredentialValidationDispatcher {
  const resolution = resolveKaanaDataPlane();
  if (resolution.status !== 'configured') {
    throw new KaanaCredentialValidationUnavailableError(
      'Kaana credential validation is not fully configured',
    );
  }
  return new HttpKaanaCredentialValidationDispatcher(resolution.config);
}

export class HttpKaanaCredentialValidationDispatcher
  implements KaanaCredentialValidationDispatcher
{
  constructor(private readonly config: KaanaDataPlaneConfig) {}

  async dispatch(input: KaanaCredentialValidationTask): Promise<void> {
    const task = kaanaCredentialValidationTaskSchema.parse(input);
    const body = Buffer.from(JSON.stringify(task), 'utf8');
    try {
      const timestamp = Date.now();
      const signature = sign(
        null,
        kaanaCredentialValidationSigningInput(this.config.keyId, timestamp, body),
        this.config.privateKey,
      ).toString('base64');
      const response = await fetch(`${this.config.baseUrl}${VALIDATION_PATH}`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'cache-control': 'no-store',
          [KEY_ID_HEADER]: this.config.keyId,
          [TIMESTAMP_HEADER]: String(timestamp),
          [SIGNATURE_HEADER]: `v1=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      const raw = await readBoundedBody(response);
      if (response.status !== 200 && response.status !== 202) {
        throw new KaanaCredentialValidationUnavailableError(
          'Kaana did not accept the exact credential validation operation',
        );
      }
      if (!response.headers.get('cache-control')?.toLowerCase().includes('no-store')) {
        throw new KaanaCredentialValidationUnavailableError(
          'Kaana returned a cacheable credential validation outcome',
        );
      }
      let parsedJSON: unknown;
      try {
        parsedJSON = JSON.parse(raw);
      } catch (error) {
        void error;
        throw new KaanaCredentialValidationUnavailableError(
          'Kaana returned an unreadable credential validation outcome',
        );
      }
      const parsed = kaanaCredentialValidationOutcomeSchema.safeParse(parsedJSON);
      if (!parsed.success || !sameTask(parsed.data, task)) {
        throw new KaanaCredentialValidationUnavailableError(
          'Kaana returned a mismatched credential validation outcome',
        );
      }
    } finally {
      body.fill(0);
    }
  }
}

export function kaanaCredentialValidationSigningInput(
  keyId: string,
  timestamp: number,
  body: Buffer,
): Buffer {
  const digest = createHash('sha256').update(body).digest('hex');
  return Buffer.from([SIGNATURE_DOMAIN, keyId, String(timestamp), digest].join('\n'), 'utf8');
}

function sameTask(
  outcome: KaanaCredentialValidationTask,
  task: KaanaCredentialValidationTask,
): boolean {
  return (
    outcome.schemaVersion === task.schemaVersion &&
    outcome.operationId === task.operationId &&
    outcome.applicationId === task.applicationId &&
    outcome.provider === task.provider &&
    outcome.ownerAccountId === task.ownerAccountId &&
    outcome.connectionId === task.connectionId &&
    outcome.environment === task.environment &&
    outcome.credentialHandle === task.credentialHandle &&
    outcome.credentialRevision === task.credentialRevision &&
    outcome.deploymentId === task.deploymentId
  );
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
        await reader.cancel('Kaana validation response exceeded its bound');
        throw new KaanaCredentialValidationUnavailableError(
          'Kaana credential validation response exceeded its bound',
        );
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
