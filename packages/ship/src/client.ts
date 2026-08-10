import fs from 'node:fs';
import type {
  AssetInitItem,
  AssetInitResponse,
  AssetCompleteResponse,
  CreateUpdateRequest,
  Update,
  Channel,
  UpdatePlatform,
} from '@oxyhq/contracts';

/** Minimal fetch surface so the client is testable without a live network. */
export type FetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | Uint8Array;
  }
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export interface ShipClientOptions {
  baseURL: string;
  /** Mints/refreshes a service JWT (typically `oxyServices.getServiceToken`). */
  getToken: () => Promise<string>;
  /** Injectable fetch (defaults to global `fetch`). */
  fetchFn?: FetchFn;
}

/**
 * Decode the `appId` (= applicationId) claim from a service JWT WITHOUT verifying
 * it — the CLI only reads its own token to learn which application it publishes
 * to; the server verifies the signature. Never trust these claims for authz.
 */
export function decodeServiceTokenAppId(token: string): string {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed service token (expected a JWT)');
  }
  let payload: { appId?: unknown };
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Could not decode service token payload');
  }
  if (typeof payload.appId !== 'string' || payload.appId.length === 0) {
    throw new Error('Service token has no appId claim');
  }
  return payload.appId;
}

/**
 * Thin authenticated client for the Oxy Updates publish/admin API. Owns the
 * service token, resolves the applicationId from it, and speaks the `{ data }`
 * envelope every admin endpoint returns.
 */
export class ShipClient {
  private readonly baseURL: string;
  private readonly getToken: () => Promise<string>;
  private readonly fetchFn: FetchFn;
  private applicationIdCache: string | null = null;

  constructor(options: ShipClientOptions) {
    this.baseURL = options.baseURL.replace(/\/$/, '');
    this.getToken = options.getToken;
    this.fetchFn = options.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  }

  /** The applicationId this client publishes to (from the service token's appId). */
  async getApplicationId(): Promise<string> {
    if (this.applicationIdCache) return this.applicationIdCache;
    const token = await this.getToken();
    this.applicationIdCache = decodeServiceTokenAppId(token);
    return this.applicationIdCache;
  }

  private async requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getToken();
    const response = await this.fetchFn(`${this.baseURL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `${method} ${path} failed (${response.status}): ${text.slice(0, 500)}`
      );
    }
    if (!text) return undefined as T;
    const parsed = JSON.parse(text) as { data?: T };
    return (parsed.data ?? parsed) as T;
  }

  async initAssets(assets: AssetInitItem[]): Promise<AssetInitResponse> {
    const applicationId = await this.getApplicationId();
    return this.requestJson<AssetInitResponse>('POST', '/updates/v1/assets/init', {
      applicationId,
      assets,
    });
  }

  /**
   * Upload raw bytes to a presigned S3 PUT URL (no auth header — the URL is
   * signed). `contentType` AND `cacheControl` are SIGNED headers baked into the
   * presign, so they MUST be replayed verbatim or S3 rejects the signature.
   */
  async uploadAsset(
    uploadUrl: string,
    contentType: string,
    cacheControl: string,
    checksumSHA256: string,
    absPath: string
  ): Promise<void> {
    const bytes = fs.readFileSync(absPath);
    const response = await this.fetchFn(uploadUrl, {
      method: 'PUT',
      headers: {
        'content-type': contentType,
        'cache-control': cacheControl,
        'x-amz-checksum-sha256': checksumSHA256,
      },
      body: bytes,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Asset upload failed (${response.status}): ${text.slice(0, 300)}`);
    }
  }

  async completeAssets(sha256s: string[]): Promise<AssetCompleteResponse> {
    const applicationId = await this.getApplicationId();
    return this.requestJson<AssetCompleteResponse>('POST', '/updates/v1/assets/complete', {
      applicationId,
      sha256s,
    });
  }

  async createUpdate(
    body: Omit<CreateUpdateRequest, 'applicationId'>
  ): Promise<Update> {
    const applicationId = await this.getApplicationId();
    const result = await this.requestJson<{ update: Update }>('POST', '/updates/v1/updates', {
      applicationId,
      ...body,
    });
    return result.update;
  }

  async rollback(
    channel: string,
    runtimeVersion: string,
    platform: UpdatePlatform
  ): Promise<{ rolledBack: Update; head: Update | null }> {
    const applicationId = await this.getApplicationId();
    return this.requestJson('POST', `/updates/v1/channels/${encodeURIComponent(channel)}/rollback`, {
      applicationId,
      runtimeVersion,
      platform,
    });
  }

  async rollbackToEmbedded(
    channel: string,
    runtimeVersion: string,
    platform: UpdatePlatform
  ): Promise<{ channel: Channel }> {
    const applicationId = await this.getApplicationId();
    return this.requestJson(
      'POST',
      `/updates/v1/channels/${encodeURIComponent(channel)}/rollback-to-embedded`,
      { applicationId, runtimeVersion, platform }
    );
  }

  async promote(
    toChannel: string,
    updateId: string,
    rolloutPercent?: number
  ): Promise<Update> {
    const applicationId = await this.getApplicationId();
    const result = await this.requestJson<{ update: Update }>(
      'POST',
      `/updates/v1/channels/${encodeURIComponent(toChannel)}/promote`,
      { applicationId, updateId, ...(rolloutPercent !== undefined ? { rolloutPercent } : {}) }
    );
    return result.update;
  }

  async listChannels(): Promise<Channel[]> {
    const applicationId = await this.getApplicationId();
    const result = await this.requestJson<{ channels: Channel[] }>(
      'GET',
      `/updates/v1/channels?applicationId=${encodeURIComponent(applicationId)}`
    );
    return result.channels;
  }

  async listUpdates(filters: {
    channel?: string;
    runtimeVersion?: string;
    platform?: UpdatePlatform;
    limit?: number;
  }): Promise<Update[]> {
    const applicationId = await this.getApplicationId();
    const query = new URLSearchParams({ applicationId });
    if (filters.runtimeVersion) query.set('runtimeVersion', filters.runtimeVersion);
    if (filters.platform) query.set('platform', filters.platform);
    if (filters.limit !== undefined) query.set('limit', String(filters.limit));
    const path = filters.channel
      ? `/updates/v1/channels/${encodeURIComponent(filters.channel)}/updates?${query}`
      : `/updates/v1/updates?${query}`;
    const result = await this.requestJson<{ updates: Update[] }>('GET', path);
    return result.updates;
  }
}
