/**
 * User-Node Methods Mixin (self-sovereign identity layer — Fase 5 user nodes)
 *
 * The client surface for a user's personal data NODE — the decentralised store
 * that holds an authentic copy of their signed-record chain. Commons drives all
 * of this:
 *
 *  - {@link OxyServicesNodesMixin.registerNode} registers (or re-registers) a
 *    SELF-HOSTED node. Registration is NOT a bespoke endpoint — it is a signed
 *    `type:'node'` v2 record (`collection: 'app.oxy.node'`, `rkey: 'self'`,
 *    last-writer-wins) published through the EXISTING `POST /identity/records`
 *    path; the server verifies it and materializes the operational
 *    {@link UserNodeStatus} cache as a side effect, so the registration's
 *    authority is the user's own signature, never an Oxy grant.
 *  - {@link OxyServicesNodesMixin.getMyNode} reads the caller's cached node
 *    status (`GET /nodes/me`) — the fast, stale-but-instant projection plus the
 *    live liveness badge Oxy maintains with background probes.
 *  - {@link OxyServicesNodesMixin.removeMyNode} revokes the registration
 *    (`DELETE /nodes/me`) so the node leaves the DID document and the liveness
 *    sweeps.
 *  - {@link OxyServicesNodesMixin.provisionManagedVault} asks Oxy to operate a
 *    MANAGED vault on the caller's behalf (`POST /nodes/managed`) — the
 *    "Create your vault" convenience for non-technical users (Oxy custodial-signs
 *    the node record; `managed:true, controller:'oxy'`).
 *  - {@link OxyServicesNodesMixin.notifyNodeIngest} sends an unauthenticated
 *    HINT (`POST /nodes/ingest/notify/:userId`) that a user's node has new
 *    records; the server fully re-verifies before ingesting, so the hint can
 *    never inject data.
 *
 * `registerNode` signs on the caller's per-subject hash chain with the on-device
 * identity key (reusing {@link SignatureService.signRecordV2} — the same
 * `ES256K-DER-SHA256` scheme + {@link signedRecordSigningInput} the identity and
 * civic mixins use), so it is NATIVE-ONLY: it throws on web (where `KeyManager`
 * has no key) and when no user is authenticated. Reading the node status,
 * revoking, provisioning a managed vault, and sending an ingest hint are plain
 * authenticated/public requests with no signing.
 *
 * The wire shapes here are API-INTERNAL (the F5 user-node surface is not yet a
 * published `@oxy.so/contracts` schema), so {@link UserNodeStatus} mirrors the
 * server's `serializeNode` projection exactly. Dates cross the wire as ISO
 * strings.
 */
import type { ChainHeadResponse } from '@oxy.so/contracts';
import type { OxyServicesBase } from '../OxyServices.base';
import { SignatureService } from '../crypto/signatureService';
import { buildUserDid } from './OxyServices.identity';
import { CACHE_TIMES } from './mixinHelpers';

/**
 * AtProto-style collection (NSID) for a user-node registration record — matches
 * the server's `NODE_COLLECTION`. A user has exactly one node, so the record is
 * keyed by the constant {@link NODE_RKEY} (last-writer-wins): re-registering
 * over-writes the single `self` record rather than appending a second node.
 */
const NODE_COLLECTION = 'app.oxy.node';

/**
 * The AtProto-style record key for the single node registration — matches the
 * server's `NODE_RKEY`. Constant (`'self'`) because a user has one node.
 */
const NODE_RKEY = 'self';

/**
 * Cache-key prefix of every node read (`GET /nodes/me`). Swept after a
 * register / revoke / managed-provision so a re-read reflects the new node
 * (or its absence) instead of a stale cached one. The identity tag is a key
 * SUFFIX, so this prefix invalidates the resource for every cached identity.
 */
const NODES_CACHE_PREFIX = 'GET:/nodes/';

/**
 * Cache-key prefix of the current user's `GET /users/me`. Swept alongside the
 * node caches because the user's derived DID document embeds an `#oxy-node`
 * service entry derived from the node row, so registering / revoking / managing
 * a node changes user-facing identity state.
 */
const USERS_ME_CACHE_PREFIX = 'GET:/users/me';

/** How Oxy and the node move records: the node pulls (default), or Oxy pushes. */
export type UserNodeMode = 'pull' | 'push';

/**
 * Who operates the node:
 *  - `self` — the user self-hosts the node (registered by their own signed
 *    `type:'node'` record).
 *  - `oxy`  — Oxy operates a MANAGED vault on the user's behalf (custodial-signed
 *    `type:'node'` record; the `controller:[OXY_DID]` model).
 */
export type UserNodeController = 'self' | 'oxy';

/**
 * Liveness badge of a node, maintained ONLY by Oxy's background probes:
 *  - `active`      — the last probe reached the node's liveness manifest.
 *  - `unreachable` — the last probe failed (DNS/connect/timeout/non-2xx); the
 *    cached row is still served, only the badge changes.
 *  - `revoked`     — the user removed the registration; excluded from the DID
 *    document and from liveness sweeps.
 */
export type UserNodeLivenessStatus = 'active' | 'unreachable' | 'revoked';

/**
 * The caller's registered node, as projected by the server's `serializeNode`
 * (`GET /nodes/me`, `POST /nodes/managed`). A denormalised, fast-to-read copy of
 * the authoritative signed `type:'node'` record plus the live liveness state Oxy
 * maintains in the background.
 *
 * `mode` / `managed` / `controller` / `status` are always present (server fields
 * with defaults); the probe/sync fields and `nodeDid` are present only once set.
 * The `Date` fields cross the wire as ISO-8601 strings.
 */
export interface UserNodeStatus {
  /** Optional DID the node advertises for itself (informational). */
  nodeDid?: string;
  /** The node's public HTTPS base URL (where its liveness manifest lives). */
  endpoint: string;
  /** The node's secp256k1 public key (hex) — records it signs verify against this. */
  nodePublicKey: string;
  /** Transport direction. `pull` (the node paces its own sync) by default. */
  mode: UserNodeMode;
  /** Whether Oxy operates this node on the user's behalf (managed vault). */
  managed: boolean;
  /** Operator of the node — `self` (user self-hosts) or `oxy` (managed vault). */
  controller: UserNodeController;
  /** Liveness badge — maintained only by background probes, never a read handler. */
  status: UserNodeLivenessStatus;
  /** Last time a probe reached the node successfully (ISO-8601). */
  lastSeenAt?: string;
  /** Last time a probe ran, success or failure (ISO-8601). */
  lastProbeAt?: string;
  /** Human-readable reason the last probe OR ingest failed (cleared on success). */
  lastError?: string;
  /** Last synced chain `seq` for two-way sync (advanced only by the ingest worker). */
  cursor?: number;
  /** Last time the ingest worker ran a pull for this node (ISO-8601). */
  lastSyncedAt?: string;
  /** When the node was first registered (ISO-8601). */
  createdAt: string;
  /** When the node row was last updated (ISO-8601). */
  updatedAt: string;
}

/**
 * Input for {@link OxyServicesNodesMixin.registerNode} — the operational facts of
 * the user's self-hosted node that go into the signed `type:'node'` record.
 */
export interface RegisterNodeInput {
  /** The node's public HTTPS base URL (where its liveness manifest is served). */
  endpoint: string;
  /** The node's secp256k1 public key (hex) — records the node signs verify against this. */
  nodePublicKey: string;
  /** Transport direction; defaults to `'pull'` when omitted. */
  mode?: UserNodeMode;
}

/** Result of {@link OxyServicesNodesMixin.removeMyNode} (`DELETE /nodes/me`). */
export interface RemoveNodeResult {
  /** `true` when an active registration was flipped to `revoked`. */
  revoked: boolean;
}

export function OxyServicesNodesMixin<T extends typeof OxyServicesBase>(Base: T) {
  return class extends Base {
    constructor(...args: any[]) {
      super(...(args as [any]));
    }

    /**
     * Register (or re-register) the caller's SELF-HOSTED personal data node.
     *
     * Builds the `{ endpoint, nodePublicKey, mode }` node record, signs a v2
     * envelope on the caller's own per-subject hash chain (fetching the current
     * chain head first so `seq`/`prev` are never stale), and publishes it through
     * the EXISTING `POST /identity/records` path — which verifies the signature
     * and materializes the operational node cache as a side effect. The signed
     * record (not this call) is the authority; re-registering over-writes the
     * single `self` record (last-writer-wins).
     *
     * NATIVE-ONLY: signs with the on-device identity key (throws on web / when no
     * identity or no authenticated user — the guard fires before any network).
     * `mode` defaults to `'pull'`. After a successful publish the node + `/users/me`
     * GET caches are swept, then the freshly-materialized status is returned.
     *
     * Throws if the chain record stored but the server skipped materialization
     * (e.g. a malformed endpoint the server rejected) — an unexpected state rather
     * than a silent `null`.
     *
     * @param input - The node's endpoint, public key, and optional transport mode.
     */
    async registerNode(input: RegisterNodeInput): Promise<UserNodeStatus> {
      try {
        const userId = this.getCurrentUserId();
        if (!userId) {
          throw new Error('No authenticated user — sign in before registering a node.');
        }
        const subject = buildUserDid(userId);
        const record: Record<string, unknown> = {
          endpoint: input.endpoint,
          nodePublicKey: input.nodePublicKey,
          mode: input.mode ?? 'pull',
        };

        // Fetch the caller's chain head fresh (uncached) so seq/prev are correct
        // → no bad_seq / chain_fork — exactly as the identity/civic signers do.
        const head = await this.makeRequest<ChainHeadResponse>(
          'GET',
          `/identity/records/${encodeURIComponent(userId)}/chain/head`,
          undefined,
          { cache: false },
        );
        const envelope = await SignatureService.signRecordV2('node', subject, record, {
          seq: head.seq + 1,
          prev: head.headRecordId,
          collection: NODE_COLLECTION,
          rkey: NODE_RKEY,
        });

        await this.makeRequest(
          'POST',
          '/identity/records',
          envelope,
          { cache: false },
        );
        this._sweepNodeCaches();

        const node = await this.getMyNode();
        if (!node) {
          throw new Error('Node registration stored but the node could not be materialized.');
        }
        return node;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Read the caller's registered node status (`GET /nodes/me`), or `null` when
     * the caller has no node. Auth required; short-TTL cached (the liveness badge
     * is background-maintained) and swept after the caller's own
     * register / revoke / managed-provision.
     */
    async getMyNode(): Promise<UserNodeStatus | null> {
      try {
        const res = await this.makeRequest<{ node: UserNodeStatus | null }>(
          'GET',
          '/nodes/me',
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.SHORT },
        );
        return res.node ?? null;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Revoke the caller's node registration (`DELETE /nodes/me`). The node flips
     * to `revoked` server-side (leaving the DID document and liveness sweeps).
     * Auth required; the node + `/users/me` GET caches are swept on success.
     *
     * Maps the server's `{ success }` to the SDK's `{ revoked }` semantic.
     */
    async removeMyNode(): Promise<RemoveNodeResult> {
      try {
        const res = await this.makeRequest<{ success: boolean }>(
          'DELETE',
          '/nodes/me',
          undefined,
          { cache: false },
        );
        this._sweepNodeCaches();
        return { revoked: res.success === true };
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Provision (or refresh) an Oxy-operated MANAGED vault for the caller
     * (`POST /nodes/managed`) — the "Create your vault" convenience for
     * non-technical users. Oxy custodial-signs the node registration onto the
     * caller's chain and returns the materialized node (`managed:true,
     * controller:'oxy'`). Idempotent server-side. Auth required; the owner id is
     * resolved from the session, never the body. The node + `/users/me` GET caches
     * are swept on success.
     */
    async provisionManagedVault(): Promise<UserNodeStatus> {
      try {
        const res = await this.makeRequest<{ node: UserNodeStatus }>(
          'POST',
          '/nodes/managed',
          undefined,
          { cache: false },
        );
        this._sweepNodeCaches();
        return res.node;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Send an ingest HINT that a user's node has new records
     * (`POST /nodes/ingest/notify/:userId`). Unauthenticated by design and
     * fire-and-forget on the server (it only schedules a background re-pull of the
     * named user's OWN node, then fully re-verifies — a notify can never inject
     * data), so this resolves once the 202 hint is accepted and returns nothing.
     *
     * @param userId - The user whose node may have new records. URL-encoded.
     */
    async notifyNodeIngest(userId: string): Promise<void> {
      try {
        await this.makeRequest<{ accepted: boolean }>(
          'POST',
          `/nodes/ingest/notify/${encodeURIComponent(userId)}`,
          undefined,
          { cache: false },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Sweep the GET caches a node mutation invalidates: every node read
     * (`GET:/nodes/`) so a re-read reflects the new node / its absence, and
     * `/users/me` because the user's derived DID document embeds an `#oxy-node`
     * service entry that changes on register / revoke / manage. Public rather
     * than `private` because mixins compose into an exported anonymous class
     * where TypeScript cannot represent a private member in the emitted
     * declaration file (TS4094) — mirrors the civic / identity cache sweepers.
     */
    _sweepNodeCaches(): void {
      this.clearCacheByPrefix(NODES_CACHE_PREFIX);
      this.clearCacheByPrefix(USERS_ME_CACHE_PREFIX);
    }
  };
}
