/**
 * `oxy.keychain` — the Oxy Keychain's routes (ADR 0063, `docs/identity/keychain.md`).
 *
 * Thin typed wrappers, one per `/keychain` route. The routes carry only
 * ciphertext, public keys, signatures and counters, so nothing here encrypts,
 * signs or verifies: every answer is checked for its SHAPE with the Zod-free
 * checks of `@oxy.so/contracts/client`, and what it MEANS is verified by the
 * device, with the keychain cryptography, in `KeychainClient`
 * (`@oxy.so/core/crypto`). Use {@link KeychainApi.openClient} unless you are
 * building a client of your own.
 *
 * Every route is the account's own (a first-party device session or an OxyOS
 * `host.self` token, acting as itself); a refusal is an `OxyApiError` whose
 * `code` is one of `KEYCHAIN_ERROR_CODES`. Nothing is cached: every answer is
 * `no-store` and a stale one would be a rollback.
 */
import {
  keychainEnrollmentResponseCheck,
  keychainEnrollmentsResponseCheck,
  keychainItemResponseCheck,
  keychainItemsResponseCheck,
  keychainStateResponseCheck,
  keychainWrapResponseCheck,
  parseContract,
  type KeychainEnrollment,
  type KeychainEntry,
  type KeychainItem,
  type KeychainItemsResponse,
  type KeychainMember,
  type KeychainStateResponse,
  type KeychainWrap,
} from '@oxy.so/contracts/client';
import type { KeychainResetRequest } from '@oxy.so/contracts';
import type { OxyContext } from '../client/context';
import type { KeychainClient, KeychainClientOptions } from '../crypto/keychain/client';

/** `POST /keychain`: the genesis entry, and the member's and the recovery wraps. */
export interface KeychainCreateInput {
  genesis: KeychainEntry;
  wraps: KeychainWrap[];
}

/** `POST /keychain/roster`: entries continuing the head, and the wraps they require. */
export interface KeychainRosterAppendInput {
  entries: KeychainEntry[];
  wraps?: KeychainWrap[];
}

/** `PUT /keychain/items/:itemId`. `baseRevision` is `null` only for an item that never existed. */
export interface KeychainItemPutInput {
  baseRevision: number | null;
  generation: number;
  nonce: string;
  ciphertext: string;
}

/** `GET /keychain/items`: the changes after `since` (default 0), at most `limit` (1–500). */
export interface KeychainItemsQueryInput {
  since?: number;
  limit?: number;
}

/** `DELETE /keychain`: a fresh re-verification (ADR 0063 D6). */
export type KeychainResetInput = KeychainResetRequest;

const NO_CACHE = { cache: false } as const;
/** Writes are never repeated by the transport: the caller decides after a 409. */
const WRITE = { cache: false, retry: false } as const;

function enrollmentPath(id: string, suffix = ''): string {
  return `/keychain/enrollments/${encodeURIComponent(id)}${suffix}`;
}

function itemPath(itemId: string): string {
  return `/keychain/items/${encodeURIComponent(itemId)}`;
}

/** A device's request to join (ADR 0063 D5): `POST|GET|DELETE /keychain/enrollments…`. */
export class KeychainEnrollmentsApi {
  constructor(private readonly ctx: OxyContext) {}

  /** `POST /keychain/enrollments` — a device that is no member asks to join. */
  async create(input: { member: KeychainMember; commitment: string }): Promise<KeychainEnrollment> {
    const res = await this.ctx.request('POST', '/keychain/enrollments', input, WRITE);
    return parseContract(keychainEnrollmentResponseCheck, res, 'POST /keychain/enrollments')
      .enrollment;
  }

  /** `GET /keychain/enrollments` — the pending requests, for a member. */
  async list(): Promise<KeychainEnrollment[]> {
    const res = await this.ctx.request('GET', '/keychain/enrollments', undefined, NO_CACHE);
    return parseContract(keychainEnrollmentsResponseCheck, res, 'GET /keychain/enrollments')
      .enrollments;
  }

  /** `GET /keychain/enrollments/:id` — for the device that asked, or a member. */
  async get(id: string): Promise<KeychainEnrollment> {
    const res = await this.ctx.request('GET', enrollmentPath(id), undefined, NO_CACHE);
    return parseContract(keychainEnrollmentResponseCheck, res, 'GET /keychain/enrollments/:id')
      .enrollment;
  }

  /** `POST /keychain/enrollments/:id/approver-nonce` — a member opens the request. */
  async postApproverNonce(
    id: string,
    input: { memberId: string; approverNonce: string },
  ): Promise<KeychainEnrollment> {
    const res = await this.ctx.request('POST', enrollmentPath(id, '/approver-nonce'), input, WRITE);
    return parseContract(
      keychainEnrollmentResponseCheck,
      res,
      'POST /keychain/enrollments/:id/approver-nonce',
    ).enrollment;
  }

  /** `POST /keychain/enrollments/:id/reveal` — the device that asked reveals its nonce, once. */
  async reveal(id: string, input: { deviceNonce: string }): Promise<KeychainEnrollment> {
    const res = await this.ctx.request('POST', enrollmentPath(id, '/reveal'), input, WRITE);
    return parseContract(
      keychainEnrollmentResponseCheck,
      res,
      'POST /keychain/enrollments/:id/reveal',
    ).enrollment;
  }

  /** `POST /keychain/enrollments/:id/approve` — the `add` entry and the new member's wrap. */
  async approve(
    id: string,
    input: { entry: KeychainEntry; wrap: KeychainWrap },
  ): Promise<KeychainStateResponse> {
    const res = await this.ctx.request('POST', enrollmentPath(id, '/approve'), input, WRITE);
    return parseContract(keychainStateResponseCheck, res, 'POST /keychain/enrollments/:id/approve');
  }

  /** `DELETE /keychain/enrollments/:id` — withdrawn by its device, or refused by a member. */
  async cancel(id: string): Promise<void> {
    await this.ctx.request('DELETE', enrollmentPath(id), undefined, WRITE);
  }
}

/** The vault's items: ciphertext under a vault-key generation (ADR 0063 D7). */
export class KeychainItemsApi {
  constructor(private readonly ctx: OxyContext) {}

  /** `GET /keychain/items?since=&limit=` — the changes after `since`, deletions included. */
  async list(query: KeychainItemsQueryInput = {}): Promise<KeychainItemsResponse> {
    const params: Record<string, number> = {};
    if (query.since !== undefined) params.since = query.since;
    if (query.limit !== undefined) params.limit = query.limit;
    const res = await this.ctx.request('GET', '/keychain/items', params, NO_CACHE);
    return parseContract(keychainItemsResponseCheck, res, 'GET /keychain/items');
  }

  /** `PUT /keychain/items/:itemId` — `409 KEYCHAIN_ITEM_CONFLICT` when `baseRevision` is stale. */
  async put(itemId: string, input: KeychainItemPutInput): Promise<KeychainItem> {
    const res = await this.ctx.request('PUT', itemPath(itemId), input, WRITE);
    return parseContract(keychainItemResponseCheck, res, 'PUT /keychain/items/:itemId').item;
  }

  /** `DELETE /keychain/items/:itemId` — a tombstone at the vault's next revision. */
  async delete(itemId: string, input: { baseRevision: number }): Promise<KeychainItem> {
    const res = await this.ctx.request('DELETE', itemPath(itemId), input, WRITE);
    return parseContract(keychainItemResponseCheck, res, 'DELETE /keychain/items/:itemId').item;
  }
}

/** `oxy.keychain`: the account's end-to-end encrypted keychain (ADR 0063). */
export class KeychainApi {
  /** Requests to join and their approval. */
  readonly enrollments: KeychainEnrollmentsApi;
  /** The items. */
  readonly items: KeychainItemsApi;

  constructor(private readonly ctx: OxyContext) {
    this.enrollments = new KeychainEnrollmentsApi(ctx);
    this.items = new KeychainItemsApi(ctx);
  }

  /** `GET /keychain` — the vault, its roster and members, and which member this device is. */
  async state(): Promise<KeychainStateResponse> {
    const res = await this.ctx.request('GET', '/keychain', undefined, NO_CACHE);
    return parseContract(keychainStateResponseCheck, res, 'GET /keychain');
  }

  /** `POST /keychain` — make the vault from its genesis entry and the first two wraps. */
  async create(input: KeychainCreateInput): Promise<KeychainStateResponse> {
    const res = await this.ctx.request('POST', '/keychain', input, WRITE);
    return parseContract(keychainStateResponseCheck, res, 'POST /keychain');
  }

  /** `POST /keychain/roster` — entries continuing the head, with the wraps they require. */
  async appendRoster(input: KeychainRosterAppendInput): Promise<KeychainStateResponse> {
    const body = { entries: input.entries, wraps: input.wraps ?? [] };
    const res = await this.ctx.request('POST', '/keychain/roster', body, WRITE);
    return parseContract(keychainStateResponseCheck, res, 'POST /keychain/roster');
  }

  /** `GET /keychain/wrap` — this device's own member's wrap. */
  async ownWrap(): Promise<KeychainWrap> {
    const res = await this.ctx.request('GET', '/keychain/wrap', undefined, NO_CACHE);
    return parseContract(keychainWrapResponseCheck, res, 'GET /keychain/wrap').wrap;
  }

  /** `GET /keychain/recovery` — the recovery wrap (it opens only with the recovery key). */
  async recoveryWrap(): Promise<KeychainWrap> {
    const res = await this.ctx.request('GET', '/keychain/recovery', undefined, NO_CACHE);
    return parseContract(keychainWrapResponseCheck, res, 'GET /keychain/recovery').wrap;
  }

  /**
   * `DELETE /keychain` — reset: delete the vault and everything in it, after a
   * fresh re-verification (`reauth` for `reset_keychain`; with a linked root, a
   * `rootProof` for `keychain_reset` over `{ vaultId }`; plus `totpCode` with an
   * authenticator). Nothing is reset silently: call it only from a control the
   * person pressed, after saying the items cannot be recovered.
   */
  async reset(input: KeychainResetInput): Promise<void> {
    await this.ctx.request('DELETE', '/keychain', input, WRITE);
  }

  /**
   * A {@link KeychainClient} for this device, driven by the platform's own
   * device-key storage. Loads the keychain cryptography (`@oxy.so/core/crypto`)
   * on first use.
   */
  async openClient(options: Omit<KeychainClientOptions, 'api'>): Promise<KeychainClient> {
    const { KeychainClient } = await import('../crypto/index');
    return new KeychainClient({ ...options, api: this });
  }
}
