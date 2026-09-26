/**
 * `oxy.nodes` — the signed-in user's personal data NODE: the decentralised store
 * that holds an authentic copy of their signed-record chain.
 *
 *  - `register` registers (or re-registers) a SELF-HOSTED node. It is a signed
 *    `type:'node'` v2 record (`collection: 'app.oxy.node'`, `rkey: 'self'`,
 *    last-writer-wins) published through `POST /identity/records`; the server
 *    verifies it and materializes the node status as a side effect, so the
 *    registration's authority is the user's own signature. NATIVE-ONLY.
 *  - `mine` reads the cached node status plus the liveness badge Oxy maintains.
 *  - `removeMine` revokes the registration.
 *  - `provisionManagedVault` asks Oxy to operate a MANAGED vault (`managed:true,
 *    controller:'oxy'`) — the "Create your vault" convenience.
 *  - `notifyIngest` sends an unauthenticated HINT that a node has new records;
 *    the server fully re-verifies before ingesting, so it can never inject data.
 *
 * The wire shapes are API-internal (not yet a published contract), so
 * {@link UserNodeStatus} mirrors the server's `serializeNode` projection.
 */
import type { OxyContext } from '../client/context';
import { signOwnChainRecord } from './identity';

/** Short-TTL read cache (the liveness badge is background-maintained). */
const SHORT_TTL = 60 * 1000;

/** A user has exactly one node: one `self` record in the node collection. */
const NODE_COLLECTION = 'app.oxy.node';
const NODE_RKEY = 'self';

/**
 * A node mutation changes every node read and `/users/me` (the derived DID
 * document embeds an `#oxy-node` service entry from the node row).
 */
const NODE_SWEEP_PREFIXES = ['GET:/nodes/', 'GET:/users/me'] as const;

/** How Oxy and the node move records: the node pulls (default), or Oxy pushes. */
export type UserNodeMode = 'pull' | 'push';

/** Who operates the node: the user (`self`) or Oxy on their behalf (`oxy`). */
export type UserNodeController = 'self' | 'oxy';

/**
 * Liveness badge, maintained ONLY by Oxy's background probes: `active` (the
 * last probe reached the manifest), `unreachable` (it failed; the cached row is
 * still served), `revoked` (the user removed the registration).
 */
export type UserNodeLivenessStatus = 'active' | 'unreachable' | 'revoked';

/** The caller's registered node, as projected by the server. Dates are ISO strings. */
export interface UserNodeStatus {
  /** Optional DID the node advertises for itself (informational). */
  nodeDid?: string;
  /** The node's public HTTPS base URL (where its liveness manifest lives). */
  endpoint: string;
  /** The node's secp256k1 public key (hex) — records it signs verify against this. */
  nodePublicKey: string;
  /** Transport direction. `pull` by default. */
  mode: UserNodeMode;
  /** Whether Oxy operates this node on the user's behalf (managed vault). */
  managed: boolean;
  /** Operator of the node. */
  controller: UserNodeController;
  /** Liveness badge — maintained only by background probes. */
  status: UserNodeLivenessStatus;
  /** Last time a probe reached the node successfully. */
  lastSeenAt?: string;
  /** Last time a probe ran, success or failure. */
  lastProbeAt?: string;
  /** Why the last probe OR ingest failed (cleared on success). */
  lastError?: string;
  /** Last synced chain `seq` (advanced only by the ingest worker). */
  cursor?: number;
  /** Last time the ingest worker pulled this node. */
  lastSyncedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Input for {@link NodesApi.register}. */
export interface RegisterNodeInput {
  /** The node's public HTTPS base URL. */
  endpoint: string;
  /** The node's secp256k1 public key (hex). */
  nodePublicKey: string;
  /** Transport direction; `'pull'` when omitted. */
  mode?: UserNodeMode;
}

/** Result of {@link NodesApi.removeMine}. */
export interface RemoveNodeResult {
  /** `true` when an active registration was flipped to `revoked`. */
  revoked: boolean;
}

export class NodesApi {
  constructor(private readonly ctx: OxyContext) {}

  /**
   * Register (or re-register) the signed-in user's SELF-HOSTED node: sign the
   * `{ endpoint, nodePublicKey, mode }` record on the caller's own chain and
   * publish it. NATIVE-ONLY; throws before any network call when signed out.
   * Returns the freshly materialized status.
   *
   * Throws if the record stored but the server skipped materialization (e.g. a
   * malformed endpoint it rejected) rather than returning a silent `null`.
   */
  async register(input: RegisterNodeInput): Promise<UserNodeStatus> {
    if (!this.ctx.oxy.session.userId) {
      throw new Error('No authenticated user — sign in before registering a node.');
    }
    const envelope = await signOwnChainRecord(
      this.ctx,
      'node',
      { endpoint: input.endpoint, nodePublicKey: input.nodePublicKey, mode: input.mode ?? 'pull' },
      { collection: NODE_COLLECTION, rkey: NODE_RKEY },
    );
    await this.ctx.request('POST', '/identity/records', envelope, { cache: false });
    this.sweep();

    const node = await this.mine();
    if (!node) {
      throw new Error('Node registration stored but the node could not be materialized.');
    }
    return node;
  }

  /** The signed-in user's node status, or `null` when they have none. Short-TTL cached. */
  async mine(): Promise<UserNodeStatus | null> {
    const res = await this.ctx.request<{ node: UserNodeStatus | null }>('GET', '/nodes/me', undefined, {
      cache: true,
      cacheTTL: SHORT_TTL,
    });
    return res.node ?? null;
  }

  /** Revoke the signed-in user's node registration. */
  async removeMine(): Promise<RemoveNodeResult> {
    const res = await this.ctx.request<{ success: boolean }>('DELETE', '/nodes/me', undefined, { cache: false });
    this.sweep();
    return { revoked: res.success === true };
  }

  /**
   * Provision (or refresh) an Oxy-operated MANAGED vault for the signed-in
   * user. Idempotent server-side; the owner comes from the session.
   */
  async provisionManagedVault(): Promise<UserNodeStatus> {
    const res = await this.ctx.request<{ node: UserNodeStatus }>('POST', '/nodes/managed', undefined, { cache: false });
    this.sweep();
    return res.node;
  }

  /**
   * Hint that `userId`'s node has new records. Unauthenticated by design and
   * fire-and-forget on the server (a 202); resolves once accepted.
   */
  async notifyIngest(userId: string): Promise<void> {
    await this.ctx.request<{ accepted: boolean }>(
      'POST',
      `/nodes/ingest/notify/${encodeURIComponent(userId)}`,
      undefined,
      { cache: false },
    );
  }

  private sweep(): void {
    this.ctx.http.invalidateCache({ prefixes: NODE_SWEEP_PREFIXES });
  }
}
