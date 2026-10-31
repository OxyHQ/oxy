import type { DeviceDirectory, DeviceSessionState } from '@oxy.so/contracts';
import {
  checkContract,
  deviceContextTokenV1ResponseCheck,
  deviceDirectoryCheck,
  deviceSessionStateCheck,
} from '@oxy.so/contracts/client';
import { resolveActiveContext } from './deviceDirectory';
import type { DeviceCredential } from './SessionClient';

/**
 * Internal experiment, not wired to SessionClient or HttpService. The caller
 * must invalidate before any input mutation and fence all authenticated entry
 * points with a lease. A lease cannot retract an already-sent request.
 */
interface ExperimentalContextBarrierIO {
  getCredential(): DeviceCredential | null;
  getAccessToken(): string | null;
  setAccessToken(token: string): void;
  mint(credential: DeviceCredential): Promise<unknown>;
  readState(accessToken: string): Promise<unknown>;
  readDirectory(accessToken: string): Promise<unknown>;
  /** Run cache/owner preparation while all token and snapshot reads are closed. */
  prepareCommit?(
    previous: ContextOwner | null,
    next: ContextOwner,
    isCurrent: () => boolean,
  ): Promise<void> | void;
}

interface ContextOwner {
  deviceId: string;
  deviceSessionId: string;
  contextId: string;
  actorId: string;
  accountId: string;
  sessionId: string;
}

interface ContextSnapshot {
  state: DeviceSessionState;
  directory: DeviceDirectory;
  deviceSessionId: string;
  contextId: string;
  actorId: string;
  accountId: string;
  sessionId: string;
  expiresAt: string;
}

function freezeSnapshot(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeSnapshot(child);
  Object.freeze(value);
}

export class ExperimentalContextBarrier {
  private generation = 0;
  private readonly listeners = new Set<() => void>();
  private highWater: { deviceId: string; deviceSessionId: string; revision: number } | null = null;
  private previousOwner: ContextOwner | null = null;
  private current: {
    snapshot: ContextSnapshot;
    token: string;
    credential: DeviceCredential;
  } | null = null;
  private phase: 'unavailable' | 'reconciling' | 'ready' = 'unavailable';

  constructor(private readonly io: ExperimentalContextBarrierIO) {}

  /** Called synchronously before a direct or push-origin mutation is observable. */
  invalidate(): void {
    this.generation += 1;
    this.current = null;
    this.phase = 'unavailable';
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* A subscriber cannot break the barrier. */
      }
    }
  }

  status(): 'unavailable' | 'reconciling' | 'ready' {
    return this.snapshot() ? 'ready' : this.phase === 'ready' ? 'unavailable' : this.phase;
  }

  snapshot(): ContextSnapshot | null {
    const current = this.current;
    const credential = this.io.getCredential();
    if (
      this.phase !== 'ready' ||
      !current ||
      !credential ||
      credential.deviceId !== current.credential.deviceId ||
      credential.deviceSecret !== current.credential.deviceSecret ||
      this.io.getAccessToken() !== current.token ||
      Date.parse(current.snapshot.expiresAt) <= Date.now()
    )
      return null;
    return current.snapshot;
  }

  lease(): number {
    if (!this.snapshot()) throw new Error('Context binding unavailable');
    return this.generation;
  }

  isCurrent(lease: number): boolean {
    return lease === this.generation && this.snapshot() !== null;
  }

  /** Never falls back to legacy minting after an unsupported or failed request. */
  async reconcile(): Promise<boolean> {
    this.invalidate();
    const generation = this.generation;
    this.phase = 'reconciling';
    const credential = this.io.getCredential();
    if (!credential) {
      this.phase = 'unavailable';
      return false;
    }
    const captured = { ...credential };
    const current = () => {
      const actual = this.io.getCredential();
      return (
        this.generation === generation &&
        actual?.deviceId === captured.deviceId &&
        actual.deviceSecret === captured.deviceSecret
      );
    };
    try {
      const binding = checkContract(
        deviceContextTokenV1ResponseCheck,
        await this.io.mint(captured),
      );
      if (!current() || !binding || binding.deviceId !== captured.deviceId) return false;
      const expires = Date.parse(binding.expiresAt);
      if (!Number.isFinite(expires) || expires <= Date.now()) return false;
      const [rawState, rawDirectory] = await Promise.all([
        this.io.readState(binding.accessToken),
        this.io.readDirectory(binding.accessToken),
      ]);
      if (!current()) return false;
      const state = checkContract(deviceSessionStateCheck, rawState);
      const directory = checkContract(deviceDirectoryCheck, rawDirectory);
      const context = resolveActiveContext(directory);
      if (
        !state ||
        !directory ||
        !context ||
        state.deviceId !== binding.deviceId ||
        directory.deviceId !== binding.deviceId ||
        state.revision !== binding.revision ||
        directory.revision !== binding.revision ||
        state.activeAccountId !== binding.accountId ||
        context.contextId !== binding.contextId ||
        context.actor.userId !== binding.actorId ||
        context.subject.accountId !== binding.accountId ||
        !context.subject.available ||
        !context.subject.onDevice ||
        !state.accounts.some(
          (row) =>
            row.accountId === binding.accountId &&
            row.sessionId === binding.sessionId &&
            (row.operatedByUserId ?? row.accountId) === binding.actorId,
        )
      )
        return false;
      if (
        this.highWater?.deviceId === binding.deviceId &&
        this.highWater.deviceSessionId === binding.deviceSessionId &&
        binding.revision < this.highWater.revision
      )
        return false;
      if (expires <= Date.now()) return false;
      const snapshot = {
        state,
        directory,
        deviceSessionId: binding.deviceSessionId,
        contextId: binding.contextId,
        actorId: binding.actorId,
        accountId: binding.accountId,
        sessionId: binding.sessionId,
        expiresAt: binding.expiresAt,
      };
      freezeSnapshot(snapshot);
      const owner = {
        deviceId: binding.deviceId,
        deviceSessionId: binding.deviceSessionId,
        contextId: binding.contextId,
        actorId: binding.actorId,
        accountId: binding.accountId,
        sessionId: binding.sessionId,
      };
      await this.io.prepareCommit?.(this.previousOwner, owner, current);
      if (!current() || expires <= Date.now()) return false;
      // setAccessToken may synchronously reenter or invalidate this barrier.
      this.io.setAccessToken(binding.accessToken);
      if (!current() || this.io.getAccessToken() !== binding.accessToken || expires <= Date.now())
        return false;
      this.current = { snapshot, token: binding.accessToken, credential: captured };
      this.highWater = {
        deviceId: binding.deviceId,
        deviceSessionId: binding.deviceSessionId,
        revision: binding.revision,
      };
      this.previousOwner = owner;
      this.phase = 'ready';
      this.notify();
      return this.isCurrent(generation);
    } catch {
      return false;
    } finally {
      if (this.generation === generation && this.phase !== 'ready') this.phase = 'unavailable';
    }
  }
}
