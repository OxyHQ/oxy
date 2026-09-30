/**
 * coldBoot — a pure, ordered, short-circuit runner for "cold boot"
 * authentication resolution.
 *
 * On a fresh page load / app launch the SDK may have several ways to recover an
 * existing session (a persisted device secret, the device's shared
 * identity, a cross-domain boot-fragment return, ...). They must be attempted
 * in a deterministic order, and the FIRST one that yields a session wins —
 * every later step is skipped. This module encodes exactly that contract and
 * nothing else.
 *
 * Design constraints (all enforced):
 *   - PURE: no DOM, no `navigator`, no `window`, no React, no platform globals.
 *   - NO module-level mutable state. Every call to {@link runColdBoot} is fully
 *     self-contained, so it is safe under bundler re-evaluation (e.g. the Metro
 *     web bundle — the reason any run-once guard for a step must live in the
 *     calling consumer, never in a core module-level singleton).
 *   - Architecture-agnostic: it knows nothing about HOW a step resolves a
 *     session; `runSessionColdBoot` (`boot/sessionColdBoot.ts`) is the current
 *     device-first consumer.
 *
 * A step is skipped (without running) when its `enabled` predicate returns
 * false. Any thrown error — from either `enabled` or `run` — is reported via
 * `onStepError` and treated as a non-fatal skip, so one broken recovery path
 * can never prevent a later, healthy one from succeeding.
 */

/**
 * A successful step result carrying the recovered session.
 */
export interface ColdBootSession<S> {
  readonly kind: 'session';
  readonly session: S;
}

/**
 * A step result indicating this step has nothing to contribute; the runner
 * should fall through to the next step.
 */
export interface ColdBootSkip {
  readonly kind: 'skip';
}

/**
 * The result of running a single cold-boot step.
 */
export type ColdBootStepResult<S> = ColdBootSession<S> | ColdBootSkip;

/**
 * A single ordered cold-boot recovery step.
 */
export interface ColdBootStep<S> {
  /** Stable identifier; surfaced as {@link ColdBootOutcome.via} on success. */
  readonly id: string;
  /**
   * Optional gate. When provided and it returns `false`, `run` is NOT called
   * and the runner moves to the next step. A throw is treated as disabled
   * (and reported via `onStepError`).
   */
  readonly enabled?: () => boolean;
  /**
   * Attempts to recover a session. Resolve with `{ kind: 'session' }` to win
   * the cold boot, or `{ kind: 'skip' }` to defer to the next step. A throw is
   * treated as a skip (and reported via `onStepError`).
   */
  readonly run: () => Promise<ColdBootStepResult<S>>;
}

/**
 * The terminal outcome of a cold boot: either the winning step's session
 * (with the step `id` it came from), or `unauthenticated` if every step
 * skipped, was disabled, or errored.
 */
export type ColdBootOutcome<S> =
  | { readonly kind: 'session'; readonly via: string; readonly session: S }
  | { readonly kind: 'unauthenticated' };

/**
 * The unique sentinel a step's `run()` resolves to (via the internal race)
 * when the overall cold-boot deadline expires before that step settled. It is
 * NOT a {@link ColdBootStepResult} — the runner detects it by identity and
 * treats it as "this step did not settle in time; move on".
 *
 * @internal
 */
const DEADLINE_EXPIRED: unique symbol = Symbol('coldBoot.deadlineExpired');

/**
 * Options for {@link runColdBoot}.
 */
export interface RunColdBootOptions<S> {
  /** Ordered steps; evaluated front to back, first session wins. */
  readonly steps: ReadonlyArray<ColdBootStep<S>>;
  /**
   * Optional observer invoked whenever a step's `enabled` or `run` throws.
   * Receives the offending step `id` and the thrown value. Must not throw;
   * the runner does not guard against an observer that itself throws.
   */
  readonly onStepError?: (id: string, error: unknown) => void;
  /**
   * Optional HARD overall deadline (ms) for the entire ordered step loop —
   * defense-in-depth so a single non-settling step can NEVER hang the whole
   * cold boot forever.
   *
   * Each step's `run()` is raced against the SHARED remaining time. If a step
   * fails to settle before the deadline, the runner abandons the await for that
   * step (reporting it via `onStepDeadline`) and CONTINUES to the next step,
   * each now racing against an already-expired deadline. This is deliberate:
   * the runner keeps iterating so the TERMINAL step (e.g. `sessionColdBoot`'s
   * `bootstrap-hop`, whose `run()` performs its navigation side effect
   * synchronously before its first `await`) still gets to fire. A step that
   * has nothing to contribute after the deadline simply doesn't settle and is
   * skipped in turn.
   *
   * Per-step timeouts inside `run()` remain the first line of defense and
   * should keep every step well under this budget on a healthy load; this only
   * trips when one of them regresses (a step hanging past its own timeout).
   * When omitted there is no overall deadline.
   */
  readonly overallDeadlineMs?: number;
  /**
   * Optional observer invoked once per step that was abandoned because the
   * overall deadline expired before it settled. Receives the step `id`. Must
   * not throw.
   */
  readonly onStepDeadline?: (id: string) => void;
}

/**
 * Run the ordered cold-boot steps and resolve to the first recovered session,
 * or `unauthenticated` if none recovers one.
 *
 * Semantics:
 *   1. Iterate `steps` in order.
 *   2. If a step has an `enabled` predicate, call it inside try/catch:
 *      - throw → report via `onStepError(id, err)` → treat as disabled → continue.
 *      - returns false → continue (skip, `run` not called).
 *   3. Otherwise await `step.run()` inside try/catch:
 *      - throw → report via `onStepError(id, err)` → continue.
 *      - `{ kind: 'session' }` → return `{ kind: 'session', via: step.id, session }`.
 *      - `{ kind: 'skip' }` → continue.
 *   4. After the loop with no winner → `{ kind: 'unauthenticated' }`.
 */
export async function runColdBoot<S>(
  options: RunColdBootOptions<S>
): Promise<ColdBootOutcome<S>> {
  const { steps, onStepError, overallDeadlineMs, onStepDeadline } = options;

  // Arm the optional overall deadline. The budget is SHARED across the whole
  // loop (not reset per step): a single timer resolves a reusable
  // `DEADLINE_EXPIRED` sentinel that every per-step race can observe. Once it
  // fires, later steps race against an already-resolved promise and so never
  // block, yet the loop keeps iterating so the terminal step still fires.
  const deadlineMs =
    typeof overallDeadlineMs === 'number' &&
    Number.isFinite(overallDeadlineMs) &&
    overallDeadlineMs > 0
      ? overallDeadlineMs
      : null;

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlinePromise: Promise<typeof DEADLINE_EXPIRED> | undefined;
  if (deadlineMs !== null) {
    deadlinePromise = new Promise<typeof DEADLINE_EXPIRED>((resolve) => {
      deadlineTimer = setTimeout(() => resolve(DEADLINE_EXPIRED), deadlineMs);
    });
  }

  try {
    for (const step of steps) {
      if (step.enabled) {
        let isEnabled: boolean;
        try {
          isEnabled = step.enabled();
        } catch (error) {
          onStepError?.(step.id, error);
          continue;
        }
        if (!isEnabled) continue;
      }

      let result: ColdBootStepResult<S> | typeof DEADLINE_EXPIRED;
      try {
        // Without a deadline, await the step directly. With a deadline, race
        // the step against the shared deadline. The
        // step's `run()` still STARTS synchronously up to its first `await`
        // (so a terminal step's synchronous navigation side effect always
        // executes), but a non-settling step can no longer block the loop —
        // the race resolves with the sentinel and we move on.
        result = deadlinePromise
          ? await Promise.race([step.run(), deadlinePromise])
          : await step.run();
      } catch (error) {
        onStepError?.(step.id, error);
        continue;
      }

      if (result === DEADLINE_EXPIRED) {
        // The deadline tripped before this step settled. Abandon the await and
        // continue: subsequent steps race against the already-resolved deadline
        // (so they cannot block), which lets a terminal side-effect step still
        // run while guaranteeing the loop terminates promptly.
        onStepDeadline?.(step.id);
        continue;
      }

      if (result.kind === 'session') {
        return { kind: 'session', via: step.id, session: result.session };
      }
    }

    return { kind: 'unauthenticated' };
  } finally {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
    }
  }
}
