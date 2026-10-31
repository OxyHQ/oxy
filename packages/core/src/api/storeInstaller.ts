/**
 * The store's installer: how a store installs, opens and updates an application on a machine
 * that installs applications, beside `oxy.store`, which reads the catalogue.
 *
 * `oxy.store` says what the store lists; an installer says what the machine can do with a
 * listing. A runtime that installs applications registers one (OxyOS's Bloom host registers one
 * backed by the system's install service before the application's code runs, OxyOS ADR 0030
 * decision 9; ADR 0053 here). Where none is registered — the web, iOS, Android — there is
 * nothing to install, and a store shows what it shows without one. An application never asks
 * which platform it runs on: it asks whether there is an installer.
 *
 * The installer is the store's hands, never its judge. It is given a listing's slug and nothing
 * else: the machine resolves slug → package → release from the store's signed metadata, verifies
 * it, and asks the person in a sheet of its own that no application can draw or press. The store
 * learns the outcome and nothing of the sheet. Its errors say whether the machine already told the
 * person (`told`), so a store never repeats what the system said.
 *
 * React-free and dependency-free, as everything in `@oxy.so/core`.
 */

/** Where a listing stands on this machine, for the action a store's page shows. */
export type StoreInstallState =
  /** The store has a release this machine can run, and it is not installed: *Get*. */
  | { state: 'notInstalled' }
  /** Being installed or updated: a progress ring. `fraction` is null while it cannot be told. */
  | { state: 'installing'; fraction: number | null }
  /** Installed and current: *Open*. */
  | { state: 'installed'; version: string }
  /**
   * Installed, with a newer release: *Update*. `needsConsent` when the newer release asks for
   * more than the installed one, which the machine asks the person for in its own sheet.
   */
  | { state: 'updateAvailable'; version: string; newVersion: string; needsConsent: boolean }
  /** The store has no release this machine can run: *Not available for this computer*. */
  | { state: 'unavailable' };

/** Why the machine could not do what the store asked. */
export type StoreInstallerFailure =
  /** The machine's install service is not running. */
  | 'serviceUnavailable'
  /** The store has no release of it this machine can run. */
  | 'notAvailable'
  /** It is not installed (opening or updating it). */
  | 'notInstalled'
  /** The installer refused the request (it lacks the right to install, or it was not a person's press). */
  | 'refused'
  /** The install or update itself failed (a download, a verification, a compile). */
  | 'failed';

/** A failure of an installer's request. */
export class StoreInstallerError extends Error {
  readonly reason: StoreInstallerFailure;
  /**
   * Whether the machine already told the person, in its own sheet. A store says nothing more
   * when it did: the system's word is the one the person reads.
   */
  readonly told: boolean;

  constructor(reason: StoreInstallerFailure, options: { told?: boolean; message?: string } = {}) {
    super(options.message ?? reason);
    this.name = 'StoreInstallerError';
    this.reason = reason;
    this.told = options.told ?? false;
  }
}

/** An update the machine has for an installed application. */
export interface StoreUpdate {
  /** The installer's own id for the application; what `apply` takes. Never a slug. */
  id: string;
  /** Its name in the person's language, from the store's signed metadata. */
  name: string;
  /** The version installed, and the one the update brings. */
  version: string;
  newVersion: string;
  /** Bytes the machine would fetch: only what it does not have already. */
  downloadSize: number;
  /** What is new, in the person's language, or null when the release says nothing. */
  releaseNotes: string | null;
  /** The update asks for more than the installed version: the machine asks the person first. */
  needsConsent: boolean;
  /** Applied, waiting for the running copy to quit: it runs at its next launch. */
  atNextLaunch: boolean;
}

/** The machine's updates for this account: one state, which every page that shows updates reads. */
export interface StoreUpdates {
  updates: StoreUpdate[];
  /** A check of the store is running. */
  checking: boolean;
  /** When the store was last read (ISO 8601), or null. */
  lastChecked: string | null;
  /** The last check failed. */
  checkFailed: boolean;
}

/** The machine's updates, as one state that changes by itself. */
export interface StoreUpdatesSource {
  /** The state last told, or null before the machine has said. */
  current(): StoreUpdates | null;
  /**
   * The state as it is now, asked of the machine without reading the store. Rejects with a
   * `StoreInstallerError` when the machine cannot say (its install service is not running).
   */
  read(): Promise<StoreUpdates>;
  /** Reads the store now. A check asked while one runs joins it. */
  check(): Promise<StoreUpdates>;
  /** Applies these updates; one that needs consent is asked in the machine's sheet first. */
  apply(ids: readonly string[]): Promise<void>;
  /** Applies every update, asking for consent in turn after the rest. */
  applyAll(): Promise<void>;
  /** Told each change; returns the unsubscribe. */
  subscribe(listener: (updates: StoreUpdates) => void): () => void;
}

/**
 * What a runtime that installs applications gives a store. Every action that changes anything is
 * asked from a person's press: the machine refuses what the person did not ask for.
 */
export interface StoreInstaller {
  /**
   * Where each listing stands. Rejects with a `StoreInstallerError` when the machine cannot say
   * (its install service is not running): a store then shows its usual action and lets the
   * machine say why when it is pressed.
   */
  status(slugs: readonly string[]): Promise<Record<string, StoreInstallState>>;
  /**
   * Installs a listing's application: the machine's sheet, then the install. Resolves when the
   * person declined in the sheet or the install is done; the progress in between is told to
   * `subscribe`'s listeners as `installing`.
   */
  install(slug: string): Promise<'installed' | 'declined'>;
  /** Updates it, asking in the machine's sheet when the update needs the person's consent. */
  update(slug: string): Promise<'updated' | 'declined'>;
  /** Removes it and its data, after the machine's sheet. */
  uninstall(slug: string): Promise<'removed' | 'declined'>;
  /** Opens the installed application. */
  open(slug: string): Promise<void>;
  /** Told each listing whose state changed; returns the unsubscribe. */
  subscribe(listener: (slug: string, state: StoreInstallState) => void): () => void;
  /** The account's updates (a store's *Updates* page). */
  readonly updates: StoreUpdatesSource;
}

let installer: StoreInstaller | null = null;

/**
 * Registers the machine's installer, or removes it with null. A runtime calls it once, before
 * the application's code runs; nothing else should.
 */
export function setStoreInstaller(next: StoreInstaller | null): void {
  installer = next;
}

/** The machine's installer, or null where nothing installs applications. */
export function getStoreInstaller(): StoreInstaller | null {
  return installer;
}
