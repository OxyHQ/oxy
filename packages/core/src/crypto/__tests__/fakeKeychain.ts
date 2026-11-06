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
 * - a delete without `accessGroup` reaches every entitled group;
 * - `application` is the app's own group, its application identifier
 *   (`<TEAM>.<bundle id>`): Apple makes every app a member of it after its
 *   `keychain-access-groups`, so it is entitled and searched last, and no
 *   other app's launch can name it.
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

/** Application identifiers: each app's own group (ADR 0062 D6). */
export const APP = {
  commons: `${TEAM}so.oxy.commons`,
  wallet: `${TEAM}to.peable.app`,
  mention: `${TEAM}so.oxy.mention`,
  alia: `${TEAM}so.oxy.alia`,
} as const;

export class FakeKeychain {
  readonly items = new Map<string, string>();
  entitlements: string[] = [...ENTITLEMENTS.preSplit];
  /** The launched app's own group, or `null` to model a keychain that refuses it. */
  application: string | null = null;
  locked = false;
  /** Mutations so far (writes and deletes). */
  mutations = 0;
  /** Throw on the mutation with this ordinal (1-based), once. */
  failMutationAt: number | null = null;
  /** A write to this `group|key` "succeeds" but stores this value instead. */
  corruptWrites = new Map<string, string>();
  /** Writes to these `group|key` throw. */
  failWrites = new Set<string>();
  /** Reads naming one of these groups throw (that group alone is unreadable). */
  failReadGroups = new Set<string>();
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

  /** Every group this app is a member of, in Apple's order. */
  private groups(): string[] {
    return this.application ? [...this.entitlements, this.application] : this.entitlements;
  }

  private entitled(group: string): void {
    if (!this.groups().includes(group)) {
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
    const groups = options.accessGroup ? [options.accessGroup] : this.groups();
    if (options.accessGroup) this.entitled(options.accessGroup);
    if (options.accessGroup && this.failReadGroups.has(options.accessGroup)) {
      throw new Error('errSecInteractionNotAllowed');
    }
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
    const groups = options.accessGroup ? [options.accessGroup] : this.groups();
    for (const group of groups) {
      this.items.delete(this.id(group, options.keychainService, key));
    }
  };

  /** What the native probe answers: the default group, or a throw while locked. */
  probe = async () =>
    this.locked
      ? { state: 'unavailable' as const, cause: new Error('errSecInteractionNotAllowed') }
      : { state: 'resolved' as const, accessGroup: this.entitlements[0] };

  /** What the application-group probe answers (protocol `loadKeychainApplicationAccessGroup`). */
  applicationProbe = async (prefix: string) =>
    this.locked
      ? { state: 'unavailable' as const, cause: new Error('errSecInteractionNotAllowed') }
      : this.application?.startsWith(prefix)
        ? { state: 'resolved' as const, accessGroup: this.application }
        : { state: 'unsupported' as const };
}
