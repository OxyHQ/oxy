/**
 * An `expo-secure-store` with the iOS keychain's access-group semantics, for
 * the access-group split (docs/identity/ios-keychain-access-groups.md):
 *
 * - an item's identity is (access group, service, key); the service defaults
 *   to `app`, like expo-secure-store's;
 * - a write without `accessGroup` lands in the DEFAULT group, the first
 *   entitlement; a write or read naming a group the app is not entitled to
 *   throws (`errSecMissingEntitlement`);
 * - a read without `accessGroup` searches every entitled group, in order;
 * - a delete without `accessGroup` reaches every entitled group.
 *
 * `entitlements` can change between "launches" (a new build), `locked` makes
 * every call throw, and `faults` injects a failure into the n-th mutation.
 */
export interface FakeKeychainOptions {
  accessGroup?: string;
  keychainService?: string;
  keychainAccessible?: unknown;
}

export const TEAM = 'ABCDE12345.';
export const GROUP = {
  identity: `${TEAM}so.oxy.identity`,
  wallet: `${TEAM}so.oxy.wallet`,
  shared: `${TEAM}group.so.oxy.shared`,
} as const;

export const ENTITLEMENTS = {
  /** Every Oxy iOS app before the split, Commons included. */
  preSplit: [GROUP.shared],
  commons: [GROUP.identity, GROUP.wallet, GROUP.shared],
  wallet: [GROUP.wallet, GROUP.shared],
  member: [GROUP.shared],
};

export class FakeKeychain {
  readonly items = new Map<string, string>();
  entitlements: string[] = [...ENTITLEMENTS.preSplit];
  locked = false;
  /** Mutations so far (writes and deletes). */
  mutations = 0;
  /** Throw on the mutation with this ordinal (1-based), once. */
  failMutationAt: number | null = null;
  /** A write to this `group|key` "succeeds" but stores this value instead. */
  corruptWrites = new Map<string, string>();
  /** Writes to these `group|key` throw. */
  failWrites = new Set<string>();
  readonly calls: Array<{
    op: 'get' | 'set' | 'delete';
    key: string;
    options: FakeKeychainOptions;
  }> = [];

  readonly WHEN_UNLOCKED_THIS_DEVICE_ONLY = 1;
  readonly WHEN_UNLOCKED = 2;

  private id(group: string, service: string | undefined, key: string): string {
    return `${group}|${service ?? 'app'}|${key}`;
  }

  private entitled(group: string): void {
    if (!this.entitlements.includes(group)) {
      throw new Error(`errSecMissingEntitlement: ${group}`);
    }
  }

  private guard(): void {
    if (this.locked) throw new Error('errSecInteractionNotAllowed');
  }

  private mutate(): void {
    this.mutations += 1;
    if (this.failMutationAt === this.mutations) {
      this.failMutationAt = null;
      throw new Error('injected fault (crash)');
    }
  }

  get(group: string, key: string, service?: string): string | null {
    return this.items.get(this.id(group, service, key)) ?? null;
  }

  put(group: string, key: string, value: string, service?: string): void {
    this.items.set(this.id(group, service, key), value);
  }

  /** Every (group, service, key) currently stored, for assertions. */
  inGroup(group: string): string[] {
    return [...this.items.keys()].filter((k) => k.startsWith(`${group}|`)).sort();
  }

  getItemAsync = async (key: string, options: FakeKeychainOptions = {}): Promise<string | null> => {
    this.calls.push({ op: 'get', key, options });
    this.guard();
    const groups = options.accessGroup ? [options.accessGroup] : this.entitlements;
    if (options.accessGroup) this.entitled(options.accessGroup);
    for (const group of groups) {
      const value = this.items.get(this.id(group, options.keychainService, key));
      if (value !== undefined) return value;
    }
    return null;
  };

  setItemAsync = async (
    key: string,
    value: string,
    options: FakeKeychainOptions = {},
  ): Promise<void> => {
    this.calls.push({ op: 'set', key, options });
    this.guard();
    const group = options.accessGroup ?? this.entitlements[0];
    this.entitled(group);
    if (this.failWrites.has(`${group}|${key}`)) throw new Error('errSecIO');
    this.mutate();
    const stored = this.corruptWrites.get(`${group}|${key}`) ?? value;
    this.items.set(this.id(group, options.keychainService, key), stored);
  };

  deleteItemAsync = async (key: string, options: FakeKeychainOptions = {}): Promise<void> => {
    this.calls.push({ op: 'delete', key, options });
    this.guard();
    if (options.accessGroup) this.entitled(options.accessGroup);
    this.mutate();
    const groups = options.accessGroup ? [options.accessGroup] : this.entitlements;
    for (const group of groups) {
      this.items.delete(this.id(group, options.keychainService, key));
    }
  };

  /** What the native probe answers: the default group, or a throw while locked. */
  probe = async () =>
    this.locked
      ? { state: 'unavailable' as const, cause: new Error('errSecInteractionNotAllowed') }
      : { state: 'resolved' as const, accessGroup: this.entitlements[0] };
}
