/**
 * An in-memory Oxy Keychain server for the client's tests: the `/keychain`
 * routes of `packages/api/src/routes/keychain.ts` and the checks of
 * `services/keychain.service.ts` and `services/keychainRoster.ts`
 * (docs/identity/keychain.md), rebuilt over the SDK's own verifier, which the
 * server's reproduces (its roster test vectors). The API's modules are not
 * imported: core never depends on the API package.
 *
 * Each device is an `OxyServices` whose `request` is routed here with that
 * device's session and context, so `oxy.keychain` (and its contract checks) is
 * exercised as on the wire. The `view` hooks let a test play a malicious Oxy.
 */
import {
  KEYCHAIN_ERROR_CODES,
  KEYCHAIN_LIMITS,
  KEYCHAIN_RECOVERY,
  type KeychainEnrollment,
  type KeychainEntry,
  type KeychainItem,
  type KeychainMember,
  type KeychainStateResponse,
  type KeychainWrap,
} from '@oxy.so/contracts/client';
import { OxyServices } from '../../../OxyServices';
import { OxyApiError } from '../../../OxyServices.errors';
import { fromBase64Url, jcs } from '../encoding';
import { verifyEnrollmentCommitment } from '../enrollment';
import { KeychainRosterError } from '../errors';
import { verifyBytes } from '../keys';
import { parseMember, parseRosterBody, rosterEntryHash, verifyRoster } from '../roster';
import { wrapSigningInput } from '../wrap';

export interface FakeDevice {
  sessionId: string;
  contextId: string;
}

interface MemberRow {
  member: KeychainMember;
  device: FakeDevice | null;
  removed: boolean;
}

interface EnrollmentRow extends KeychainEnrollment {
  device: FakeDevice | null;
}

interface Vault {
  id: string;
  generation: number;
  revision: number;
  roster: KeychainEntry[];
}

/** What a malicious Oxy shows a device instead of the truth. */
export interface FakeServerViews {
  roster?: (roster: KeychainEntry[], device: FakeDevice) => KeychainEntry[];
  items?: (items: KeychainItem[], device: FakeDevice) => KeychainItem[];
  ownWrap?: (wrap: KeychainWrap, device: FakeDevice) => KeychainWrap;
  enrollment?: (enrollment: KeychainEnrollment, device: FakeDevice) => KeychainEnrollment;
}

let counter = 0;
function uuid(): string {
  counter += 1;
  const hex = counter.toString(16).padStart(12, '0');
  return `00000000-0000-7000-8000-${hex}`;
}

function refuse(status: number, code: string, message = code): never {
  throw new OxyApiError(message, { status, code });
}

function sameDevice(a: FakeDevice | null, b: FakeDevice): boolean {
  return a !== null && a.sessionId === b.sessionId && a.contextId === b.contextId;
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** `GET /keychain`'s vault summary, computed from the roster it is answered with. */
function summaryOf(
  vault: Vault,
  roster: KeychainEntry[],
): NonNullable<KeychainStateResponse['vault']> {
  let generation = 1;
  for (const entry of roster) {
    const body = JSON.parse(entry.body) as { op: string; generation?: number };
    if (body.op === 'generation') generation = body.generation as number;
  }
  return {
    id: vault.id,
    genesisHash: rosterEntryHash(roster[0].body),
    rosterSeq: roster.length - 1,
    rosterHead: rosterEntryHash(roster[roster.length - 1].body),
    generation,
    revision: vault.revision,
  };
}

export class FakeKeychainServer {
  vault: Vault | null = null;
  readonly members = new Map<string, MemberRow>();
  readonly wraps = new Map<string, KeychainWrap>();
  readonly items = new Map<string, KeychainItem>();
  readonly enrollments = new Map<string, EnrollmentRow>();
  views: FakeServerViews = {};
  /** Every request, for assertions. */
  readonly log: { method: string; path: string }[] = [];

  /** A client of this server for one device of the account. */
  device(name: string): { oxy: OxyServices; device: FakeDevice } {
    const device: FakeDevice = { sessionId: `session-${name}`, contextId: `context-${name}` };
    const oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    jest
      .spyOn(oxy, 'request')
      .mockImplementation((method, url, data) =>
        this.handle(device, method, url, clone(data)).then(clone),
      );
    return { oxy, device };
  }

  /** The account leaves `device` (signed out): its members are orphaned for good (D4). */
  leave(device: FakeDevice): void {
    for (const row of this.members.values()) if (sameDevice(row.device, device)) row.device = null;
    for (const row of this.enrollments.values()) {
      if (sameDevice(row.device, device)) row.device = null;
    }
  }

  // ── Routing ───────────────────────────────────────────────────────────────

  async handle(device: FakeDevice, method: string, url: string, data: unknown): Promise<unknown> {
    const path = url.split('?')[0];
    this.log.push({ method, path });
    const body = (data ?? {}) as Record<string, unknown>;
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'keychain') refuse(404, 'NOT_FOUND');
    const [, a, b, c] = parts;
    if (a === undefined) {
      if (method === 'GET') return this.state(device);
      if (method === 'POST') return this.create(device, body);
      if (method === 'DELETE') return this.reset(body);
    }
    if (a === 'roster' && method === 'POST') return this.append(device, body);
    if (a === 'wrap' && method === 'GET') return { wrap: this.ownWrap(device) };
    if (a === 'recovery' && method === 'GET') return { wrap: this.recoveryWrap() };
    if (a === 'enrollments') {
      if (b === undefined && method === 'POST') return this.createEnrollment(device, body);
      if (b === undefined && method === 'GET') return this.listEnrollments(device);
      if (b !== undefined && c === undefined && method === 'GET') {
        return { enrollment: this.view(this.enrollmentFor(device, b), device) };
      }
      if (b !== undefined && c === undefined && method === 'DELETE') return this.cancel(device, b);
      if (c === 'approver-nonce') return this.approverNonce(device, b, body);
      if (c === 'reveal') return this.reveal(device, b, body);
      if (c === 'approve') return this.approve(device, b, body);
    }
    if (a === 'items') {
      if (b === undefined && method === 'GET') return this.listItems(device, body);
      if (b !== undefined && method === 'PUT') return { item: this.putItem(device, b, body) };
      if (b !== undefined && method === 'DELETE') return { item: this.deleteItem(device, b, body) };
    }
    return refuse(404, 'NOT_FOUND');
  }

  // ── Vault and roster ──────────────────────────────────────────────────────

  private requireVault(): Vault {
    if (!this.vault) refuse(404, KEYCHAIN_ERROR_CODES.notFound);
    return this.vault;
  }

  private memberOf(device: FakeDevice): MemberRow | null {
    for (const row of this.members.values()) {
      if (!row.removed && sameDevice(row.device, device)) return row;
    }
    return null;
  }

  private requireMember(device: FakeDevice): MemberRow {
    const row = this.memberOf(device);
    if (!row) refuse(403, KEYCHAIN_ERROR_CODES.notMember);
    return row;
  }

  state(device: FakeDevice): KeychainStateResponse {
    const vault = this.vault;
    if (!vault) return { vault: null, roster: [], members: [], self: null };
    const roster = this.views.roster
      ? this.views.roster(clone(vault.roster), device)
      : vault.roster;
    return {
      vault: summaryOf(vault, roster),
      roster,
      members: [...this.members.values()].map((row) => ({
        id: row.member.id,
        orphaned: row.device === null,
        removed: row.removed,
      })),
      self: this.memberOf(device)?.member.id ?? null,
    };
  }

  /** Verify `entries` as the continuation of the roster, as the API's `applyEntries`. */
  private apply(entries: KeychainEntry[]) {
    const vault = this.requireVault();
    const head = vault.roster.length - 1;
    let first: ReturnType<typeof parseRosterBody>;
    try {
      first = parseRosterBody(entries[0].body);
    } catch {
      return refuse(400, KEYCHAIN_ERROR_CODES.rosterInvalid);
    }
    if (first.seq !== head + 1 || first.prev !== rosterEntryHash(vault.roster[head].body)) {
      refuse(409, KEYCHAIN_ERROR_CODES.rosterConflict);
    }
    let verified: ReturnType<typeof verifyRoster>;
    try {
      verified = verifyRoster([...vault.roster, ...entries]);
    } catch (error) {
      if (error instanceof KeychainRosterError && error.reason === 'incomplete') {
        refuse(400, KEYCHAIN_ERROR_CODES.rotationIncomplete);
      }
      return refuse(400, KEYCHAIN_ERROR_CODES.rosterInvalid);
    }
    const bodies = entries.map((entry) => parseRosterBody(entry.body));
    const added = bodies.flatMap((body) => (body.op === 'add' ? [body.member] : []));
    const removed = bodies.flatMap((body) => (body.op === 'remove' ? [body.memberId] : []));
    const rotates = bodies.some((body) => body.op === 'generation');
    return { verified, added, removed, rotates };
  }

  /** The API's `requireWraps`: exactly these recipients, newest generation, signed by `signers`. */
  private requireWraps(
    wraps: KeychainWrap[],
    recipients: Set<string>,
    generation: number,
    signers: Map<string, string>,
    rotation: boolean,
  ): void {
    const vaultId = this.requireVault().id;
    const seen = new Set<string>();
    for (const wrap of wraps) {
      if (seen.has(wrap.recipient) || !recipients.has(wrap.recipient)) {
        refuse(400, KEYCHAIN_ERROR_CODES.wrapInvalid);
      }
      seen.add(wrap.recipient);
      if (wrap.generation !== generation) refuse(400, KEYCHAIN_ERROR_CODES.wrapInvalid);
      const key = signers.get(wrap.signer);
      if (
        !key ||
        !verifyBytes(
          fromBase64Url(key, 32),
          wrapSigningInput(vaultId, wrap),
          fromBase64Url(wrap.signature, 64),
        )
      ) {
        refuse(400, KEYCHAIN_ERROR_CODES.wrapInvalid);
      }
    }
    for (const recipient of recipients) {
      if (!seen.has(recipient)) {
        refuse(
          400,
          rotation ? KEYCHAIN_ERROR_CODES.rotationIncomplete : KEYCHAIN_ERROR_CODES.wrapInvalid,
        );
      }
    }
  }

  private persist(
    entries: KeychainEntry[],
    wraps: KeychainWrap[],
    bindings: Map<string, FakeDevice>,
    generation: number,
  ): void {
    const vault = this.requireVault();
    for (const entry of entries) {
      const body = parseRosterBody(entry.body);
      if (body.op === 'genesis' || body.op === 'add') {
        if (this.memberOf(bindings.get(body.member.id) as FakeDevice)) {
          refuse(409, KEYCHAIN_ERROR_CODES.alreadyMember);
        }
        this.members.set(body.member.id, {
          member: body.member,
          device: bindings.get(body.member.id) as FakeDevice,
          removed: false,
        });
      } else if (body.op === 'remove') {
        (this.members.get(body.memberId) as MemberRow).removed = true;
        this.wraps.delete(body.memberId);
      }
      vault.roster.push(clone(entry));
    }
    for (const wrap of wraps) this.wraps.set(wrap.recipient, clone(wrap));
    vault.generation = generation;
  }

  private create(device: FakeDevice, body: Record<string, unknown>): KeychainStateResponse {
    if (this.vault) refuse(409, KEYCHAIN_ERROR_CODES.exists);
    const genesis = body.genesis as KeychainEntry;
    const wraps = body.wraps as KeychainWrap[];
    let verified: ReturnType<typeof verifyRoster>;
    try {
      verified = verifyRoster([genesis]);
    } catch {
      return refuse(400, KEYCHAIN_ERROR_CODES.rosterInvalid);
    }
    const [member] = verified.members;
    this.vault = { id: verified.vaultId, generation: 1, revision: 0, roster: [] };
    try {
      this.requireWraps(
        wraps,
        new Set([member.id, KEYCHAIN_RECOVERY]),
        1,
        new Map([[member.id, member.signingKey]]),
        false,
      );
    } catch (error) {
      this.vault = null;
      throw error;
    }
    this.persist([genesis], wraps, new Map([[member.id, device]]), 1);
    return this.state(device);
  }

  private append(device: FakeDevice, body: Record<string, unknown>): KeychainStateResponse {
    const vault = this.requireVault();
    const entries = body.entries as KeychainEntry[];
    const wraps = (body.wraps ?? []) as KeychainWrap[];
    const caller = this.memberOf(device);
    const before = verifyRoster(vault.roster);
    const { verified, added, rotates } = this.apply(entries);
    const bindings = new Map<string, FakeDevice>();
    if (caller) {
      if (added.length > 0) refuse(400, KEYCHAIN_ERROR_CODES.rosterInvalid);
      const recipients = new Set<string>();
      if (rotates) {
        for (const m of verified.members) recipients.add(m.id);
        recipients.add(KEYCHAIN_RECOVERY);
      }
      this.requireWraps(
        wraps,
        recipients,
        verified.generation,
        new Map([[caller.member.id, caller.member.signingKey]]),
        rotates,
      );
    } else {
      const recoveryAdd =
        entries.length === 1 &&
        added.length === 1 &&
        entries[0].signatures.every((s) => s.signer === KEYCHAIN_RECOVERY);
      if (!recoveryAdd) refuse(403, KEYCHAIN_ERROR_CODES.notMember);
      this.requireWraps(
        wraps,
        new Set([added[0].id]),
        verified.generation,
        new Map([[KEYCHAIN_RECOVERY, before.recovery.signingKey]]),
        false,
      );
      bindings.set(added[0].id, device);
    }
    this.persist(entries, wraps, bindings, verified.generation);
    return this.state(device);
  }

  private ownWrap(device: FakeDevice): KeychainWrap {
    this.requireVault();
    const row = this.memberOf(device);
    const wrap = row ? this.wraps.get(row.member.id) : undefined;
    if (!wrap) refuse(404, KEYCHAIN_ERROR_CODES.notMember);
    return this.views.ownWrap ? this.views.ownWrap(clone(wrap), device) : wrap;
  }

  private recoveryWrap(): KeychainWrap {
    this.requireVault();
    const wrap = this.wraps.get(KEYCHAIN_RECOVERY);
    if (!wrap) refuse(404, KEYCHAIN_ERROR_CODES.notFound);
    return wrap;
  }

  private reset(body: Record<string, unknown>): undefined {
    this.requireVault();
    const reauth = body.reauth as { password?: string } | undefined;
    if (!reauth || reauth.password !== 'correct horse') refuse(401, 'REAUTH_REQUIRED');
    this.vault = null;
    this.members.clear();
    this.wraps.clear();
    this.items.clear();
    this.enrollments.clear();
    return undefined;
  }

  // ── Enrollments ───────────────────────────────────────────────────────────

  private view(row: EnrollmentRow, device: FakeDevice): KeychainEnrollment {
    const { device: _device, ...enrollment } = row;
    const answer = clone(enrollment);
    return this.views.enrollment ? this.views.enrollment(answer, device) : answer;
  }

  private createEnrollment(device: FakeDevice, body: Record<string, unknown>) {
    const vault = this.requireVault();
    if (this.memberOf(device)) refuse(409, KEYCHAIN_ERROR_CODES.alreadyMember);
    const member = parseMember(body.member);
    if (this.members.has(member.id)) refuse(400, KEYCHAIN_ERROR_CODES.rosterInvalid);
    for (const [id, row] of this.enrollments) {
      if (row.status === 'pending' && sameDevice(row.device, device)) this.enrollments.delete(id);
    }
    const pending = [...this.enrollments.values()].filter((row) => row.status === 'pending');
    if (pending.length >= KEYCHAIN_LIMITS.maxPendingEnrollments) {
      refuse(409, KEYCHAIN_ERROR_CODES.limitReached);
    }
    const now = new Date();
    const row: EnrollmentRow = {
      id: uuid(),
      vaultId: vault.id,
      member,
      commitment: body.commitment as string,
      approverNonce: null,
      approverMemberId: null,
      deviceNonce: null,
      status: 'pending',
      expiresAt: new Date(now.getTime() + KEYCHAIN_LIMITS.enrollmentTtlMs).toISOString(),
      createdAt: now.toISOString(),
      device,
    };
    this.enrollments.set(row.id, row);
    return { enrollment: this.view(row, device) };
  }

  private listEnrollments(device: FakeDevice) {
    this.requireVault();
    this.requireMember(device);
    return {
      enrollments: [...this.enrollments.values()]
        .filter((row) => row.status === 'pending')
        .map((row) => this.view(row, device)),
    };
  }

  private enrollmentFor(device: FakeDevice, id: string): EnrollmentRow {
    this.requireVault();
    const row = this.enrollments.get(id);
    if (!row) refuse(404, KEYCHAIN_ERROR_CODES.enrollmentNotFound);
    if (!sameDevice(row.device, device) && !this.memberOf(device)) {
      refuse(404, KEYCHAIN_ERROR_CODES.enrollmentNotFound);
    }
    return row;
  }

  private approverNonce(device: FakeDevice, id: string, body: Record<string, unknown>) {
    const caller = this.requireMember(device);
    if (caller.member.id !== body.memberId) refuse(409, KEYCHAIN_ERROR_CODES.enrollmentState);
    const row = this.enrollmentFor(device, id);
    if (row.status !== 'pending' || row.approverNonce !== null) {
      refuse(409, KEYCHAIN_ERROR_CODES.enrollmentState);
    }
    row.approverNonce = body.approverNonce as string;
    row.approverMemberId = caller.member.id;
    return { enrollment: this.view(row, device) };
  }

  private reveal(device: FakeDevice, id: string, body: Record<string, unknown>) {
    const vault = this.requireVault();
    const row = this.enrollmentFor(device, id);
    if (!sameDevice(row.device, device)) refuse(404, KEYCHAIN_ERROR_CODES.enrollmentNotFound);
    if (row.status !== 'pending' || row.approverNonce === null || row.deviceNonce !== null) {
      refuse(409, KEYCHAIN_ERROR_CODES.enrollmentState);
    }
    const nonce = fromBase64Url(body.deviceNonce as string, 32);
    if (!verifyEnrollmentCommitment(vault.id, row.member, nonce, row.commitment)) {
      row.status = 'denied';
      refuse(400, KEYCHAIN_ERROR_CODES.commitmentMismatch);
    }
    row.deviceNonce = body.deviceNonce as string;
    return { enrollment: this.view(row, device) };
  }

  private approve(device: FakeDevice, id: string, body: Record<string, unknown>) {
    const caller = this.requireMember(device);
    const row = this.enrollmentFor(device, id);
    if (row.status !== 'pending') refuse(409, KEYCHAIN_ERROR_CODES.enrollmentState);
    if (row.approverMemberId !== caller.member.id || row.deviceNonce === null) {
      refuse(409, KEYCHAIN_ERROR_CODES.enrollmentState);
    }
    if (!row.device) refuse(404, KEYCHAIN_ERROR_CODES.enrollmentNotFound);
    const entry = body.entry as KeychainEntry;
    const wrap = body.wrap as KeychainWrap;
    const { verified, added } = this.apply([entry]);
    if (added.length !== 1 || jcs(added[0]) !== jcs(row.member)) {
      refuse(400, KEYCHAIN_ERROR_CODES.rosterInvalid);
    }
    if (entry.signatures.length !== 1 || entry.signatures[0].signer !== caller.member.id) {
      refuse(400, KEYCHAIN_ERROR_CODES.rosterInvalid);
    }
    this.requireWraps(
      [wrap],
      new Set([added[0].id]),
      verified.generation,
      new Map([[caller.member.id, caller.member.signingKey]]),
      false,
    );
    this.persist([entry], [wrap], new Map([[added[0].id, row.device]]), verified.generation);
    row.status = 'approved';
    return this.state(device);
  }

  private cancel(device: FakeDevice, id: string): undefined {
    const row = this.enrollmentFor(device, id);
    if (sameDevice(row.device, device)) this.enrollments.delete(id);
    else if (row.status === 'pending') row.status = 'denied';
    return undefined;
  }

  // ── Items ─────────────────────────────────────────────────────────────────

  private listItems(device: FakeDevice, query: Record<string, unknown>) {
    const vault = this.requireVault();
    this.requireMember(device);
    const since = Number(query.since ?? 0);
    const limit = Number(query.limit ?? KEYCHAIN_LIMITS.maxItemsPage);
    const all = [...this.items.values()]
      .filter((item) => item.revision > since && item.revision <= vault.revision)
      .sort((x, y) => x.revision - y.revision);
    const shown = this.views.items ? this.views.items(clone(all), device) : all;
    return { items: shown.slice(0, limit), revision: vault.revision, more: shown.length > limit };
  }

  private putItem(device: FakeDevice, itemId: string, body: Record<string, unknown>): KeychainItem {
    const vault = this.requireVault();
    this.requireMember(device);
    if ((body.generation as number) > vault.generation) {
      refuse(400, KEYCHAIN_ERROR_CODES.generationInvalid);
    }
    const existing = this.items.get(itemId);
    const base = body.baseRevision as number | null;
    if (base === null ? existing !== undefined : existing?.revision !== base) {
      refuse(409, KEYCHAIN_ERROR_CODES.itemConflict);
    }
    vault.revision += 1;
    const item: KeychainItem = {
      id: itemId,
      revision: vault.revision,
      generation: body.generation as number,
      nonce: body.nonce as string,
      ciphertext: body.ciphertext as string,
      deletedAt: null,
      updatedAt: new Date().toISOString(),
    };
    this.items.set(itemId, item);
    return item;
  }

  private deleteItem(
    device: FakeDevice,
    itemId: string,
    body: Record<string, unknown>,
  ): KeychainItem {
    const vault = this.requireVault();
    this.requireMember(device);
    const existing = this.items.get(itemId);
    if (!existing || existing.deletedAt !== null) refuse(404, KEYCHAIN_ERROR_CODES.itemNotFound);
    if (existing.revision !== body.baseRevision) refuse(409, KEYCHAIN_ERROR_CODES.itemConflict);
    vault.revision += 1;
    const now = new Date().toISOString();
    const item: KeychainItem = {
      ...existing,
      revision: vault.revision,
      nonce: null,
      ciphertext: null,
      deletedAt: now,
      updatedAt: now,
    };
    this.items.set(itemId, item);
    return item;
  }
}
