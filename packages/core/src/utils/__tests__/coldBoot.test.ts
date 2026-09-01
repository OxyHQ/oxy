import {
  runColdBoot,
  type ColdBootStep,
  type ColdBootStepResult,
} from '../coldBoot';

interface TestSession {
  readonly userId: string;
}

function sessionStep(
  id: string,
  userId: string,
  onRun?: () => void
): ColdBootStep<TestSession> {
  return {
    id,
    run: async (): Promise<ColdBootStepResult<TestSession>> => {
      onRun?.();
      return { kind: 'session', session: { userId } };
    },
  };
}

function skipStep(id: string, onRun?: () => void): ColdBootStep<TestSession> {
  return {
    id,
    run: async (): Promise<ColdBootStepResult<TestSession>> => {
      onRun?.();
      return { kind: 'skip' };
    },
  };
}

describe('runColdBoot', () => {
  it('returns the first session and short-circuits remaining steps', async () => {
    const ranLater = jest.fn();
    const outcome = await runColdBoot<TestSession>({
      steps: [
        skipStep('first'),
        sessionStep('winner', 'u-123'),
        sessionStep('later', 'u-999', ranLater),
      ],
    });

    expect(outcome).toEqual({
      kind: 'session',
      via: 'winner',
      session: { userId: 'u-123' },
    });
    expect(ranLater).not.toHaveBeenCalled();
  });

  it('outcome.via is the winning step id', async () => {
    const outcome = await runColdBoot<TestSession>({
      steps: [skipStep('a'), skipStep('b'), sessionStep('c', 'u-7')],
    });

    expect(outcome.kind).toBe('session');
    if (outcome.kind === 'session') {
      expect(outcome.via).toBe('c');
      expect(outcome.session).toEqual({ userId: 'u-7' });
    }
  });

  it('returns unauthenticated when every step skips', async () => {
    const outcome = await runColdBoot<TestSession>({
      steps: [skipStep('a'), skipStep('b'), skipStep('c')],
    });

    expect(outcome).toEqual({ kind: 'unauthenticated' });
  });

  it('returns unauthenticated for an empty step list', async () => {
    const outcome = await runColdBoot<TestSession>({ steps: [] });
    expect(outcome).toEqual({ kind: 'unauthenticated' });
  });

  it('skips a disabled step WITHOUT calling its run()', async () => {
    const disabledRun = jest.fn();
    const outcome = await runColdBoot<TestSession>({
      steps: [
        {
          id: 'disabled',
          enabled: () => false,
          run: async (): Promise<ColdBootStepResult<TestSession>> => {
            disabledRun();
            return { kind: 'session', session: { userId: 'should-not-run' } };
          },
        },
        sessionStep('enabled', 'u-ok'),
      ],
    });

    expect(disabledRun).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      kind: 'session',
      via: 'enabled',
      session: { userId: 'u-ok' },
    });
  });

  it('runs an enabled:()=>true step', async () => {
    const outcome = await runColdBoot<TestSession>({
      steps: [
        {
          id: 'gated',
          enabled: () => true,
          run: async (): Promise<ColdBootStepResult<TestSession>> => ({
            kind: 'session',
            session: { userId: 'u-gated' },
          }),
        },
      ],
    });

    expect(outcome).toEqual({
      kind: 'session',
      via: 'gated',
      session: { userId: 'u-gated' },
    });
  });

  it('reports a thrown run() via onStepError and continues to the next step', async () => {
    const onStepError = jest.fn();
    const boom = new Error('run exploded');
    const outcome = await runColdBoot<TestSession>({
      steps: [
        {
          id: 'throws',
          run: async (): Promise<ColdBootStepResult<TestSession>> => {
            throw boom;
          },
        },
        sessionStep('recovers', 'u-after-throw'),
      ],
      onStepError,
    });

    expect(onStepError).toHaveBeenCalledTimes(1);
    expect(onStepError).toHaveBeenCalledWith('throws', boom);
    expect(outcome).toEqual({
      kind: 'session',
      via: 'recovers',
      session: { userId: 'u-after-throw' },
    });
  });

  it('treats a thrown enabled() as disabled, reports via onStepError, and continues', async () => {
    const onStepError = jest.fn();
    const enabledThrew = new Error('enabled exploded');
    const guardedRun = jest.fn();
    const outcome = await runColdBoot<TestSession>({
      steps: [
        {
          id: 'enabled-throws',
          enabled: () => {
            throw enabledThrew;
          },
          run: async (): Promise<ColdBootStepResult<TestSession>> => {
            guardedRun();
            return { kind: 'session', session: { userId: 'should-not-run' } };
          },
        },
        sessionStep('next', 'u-next'),
      ],
      onStepError,
    });

    expect(guardedRun).not.toHaveBeenCalled();
    expect(onStepError).toHaveBeenCalledTimes(1);
    expect(onStepError).toHaveBeenCalledWith('enabled-throws', enabledThrew);
    expect(outcome).toEqual({
      kind: 'session',
      via: 'next',
      session: { userId: 'u-next' },
    });
  });

  it('returns unauthenticated when all steps error and reports each', async () => {
    const onStepError = jest.fn();
    const outcome = await runColdBoot<TestSession>({
      steps: [
        {
          id: 'a',
          run: async (): Promise<ColdBootStepResult<TestSession>> => {
            throw new Error('a');
          },
        },
        {
          id: 'b',
          enabled: () => {
            throw new Error('b');
          },
          run: async (): Promise<ColdBootStepResult<TestSession>> => ({
            kind: 'skip',
          }),
        },
      ],
      onStepError,
    });

    expect(outcome).toEqual({ kind: 'unauthenticated' });
    expect(onStepError).toHaveBeenCalledTimes(2);
  });

  it('does not require onStepError to be provided when a step throws', async () => {
    const outcome = await runColdBoot<TestSession>({
      steps: [
        {
          id: 'throws',
          run: async (): Promise<ColdBootStepResult<TestSession>> => {
            throw new Error('no observer');
          },
        },
        sessionStep('ok', 'u-ok'),
      ],
    });

    expect(outcome).toEqual({
      kind: 'session',
      via: 'ok',
      session: { userId: 'u-ok' },
    });
  });

  describe('overall deadline (defense-in-depth)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    });

    /**
     * A step whose `run()` promise NEVER settles (e.g. an async call that
     * ignores its abort signal). WITHOUT a deadline the whole `runColdBoot`
     * promise hangs forever and the terminal step never runs.
     */
    it('hangs forever when a step never settles and no deadline is set', async () => {
      const terminalRan = jest.fn();
      let settled = false;
      let releaseHang: (() => void) | undefined;

      const outcomePromise = runColdBoot<TestSession>({
        steps: [
          {
            id: 'never-settles',
            // Never resolves or rejects until the test tears down — models a hung async call.
            run: () =>
              new Promise<ColdBootStepResult<TestSession>>((resolve) => {
                releaseHang = () => resolve({ kind: 'skip' });
              }),
          },
          {
            id: 'terminal',
            run: async (): Promise<ColdBootStepResult<TestSession>> => {
              terminalRan();
              return { kind: 'skip' };
            },
          },
        ],
      }).then((o) => {
        settled = true;
        return o;
      });

      // Advance well past any reasonable budget; nothing can unblock it.
      await jest.advanceTimersByTimeAsync(120000);

      expect(settled).toBe(false);
      expect(terminalRan).not.toHaveBeenCalled();

      // Tear down the intentional hang so Jest workers can exit cleanly.
      releaseHang?.();
      await outcomePromise;
    });

    /**
     * With `overallDeadlineMs` set, the non-settling step is abandoned at the
     * deadline, the runner CONTINUES to the terminal step, and the whole boot
     * settles to `unauthenticated` within the bounded budget.
     */
    it('abandons a non-settling step at the deadline and still runs the terminal step', async () => {
      const terminalRan = jest.fn();
      const onStepDeadline = jest.fn();

      const outcomePromise = runColdBoot<TestSession>({
        overallDeadlineMs: 5000,
        onStepDeadline,
        steps: [
          {
            id: 'never-settles',
            run: () => new Promise<ColdBootStepResult<TestSession>>(() => {}),
          },
          {
            id: 'terminal',
            run: async (): Promise<ColdBootStepResult<TestSession>> => {
              terminalRan();
              return { kind: 'skip' };
            },
          },
        ],
      });

      await jest.advanceTimersByTimeAsync(5000);
      const outcome = await outcomePromise;

      expect(onStepDeadline).toHaveBeenCalledWith('never-settles');
      expect(terminalRan).toHaveBeenCalledTimes(1);
      expect(outcome).toEqual({ kind: 'unauthenticated' });
    });

    /**
     * A terminal step may run a synchronous side effect before its first
     * `await`; that side effect must still execute when the deadline trips on
     * an earlier step — the terminal fallback is preserved.
     */
    it('lets the terminal step fire its synchronous side effect after the deadline trips', async () => {
      const terminalSideEffect = jest.fn();

      const outcomePromise = runColdBoot<TestSession>({
        overallDeadlineMs: 3000,
        steps: [
          {
            id: 'never-settles',
            run: () => new Promise<ColdBootStepResult<TestSession>>(() => {}),
          },
          {
            id: 'terminal',
            run: async (): Promise<ColdBootStepResult<TestSession>> => {
              // Synchronous side effect that fires before the first await.
              terminalSideEffect();
              return { kind: 'skip' };
            },
          },
        ],
      });

      await jest.advanceTimersByTimeAsync(3000);
      await outcomePromise;

      expect(terminalSideEffect).toHaveBeenCalledTimes(1);
    });

    /**
     * A healthy step that settles BEFORE the deadline still wins and
     * short-circuits — the deadline never alters the happy path.
     */
    it('a step that settles before the deadline wins and short-circuits', async () => {
      const laterRan = jest.fn();

      const outcomePromise = runColdBoot<TestSession>({
        overallDeadlineMs: 10000,
        steps: [
          {
            id: 'fast-winner',
            run: async (): Promise<ColdBootStepResult<TestSession>> => {
              await Promise.resolve();
              return { kind: 'session', session: { userId: 'u-fast' } };
            },
          },
          sessionStep('later', 'u-later', laterRan),
        ],
      });

      await jest.advanceTimersByTimeAsync(0);
      const outcome = await outcomePromise;

      expect(outcome).toEqual({
        kind: 'session',
        via: 'fast-winner',
        session: { userId: 'u-fast' },
      });
      expect(laterRan).not.toHaveBeenCalled();
    });
  });

  /**
   * End-to-end deadline semantics over a longer chain at the real overall
   * deadline a consumer arms (the runner itself has no default). Models a chain
   * whose FIRST step never settles — its `run()` promise ignores the abort
   * signal and stays pending — followed by several no-op steps and a terminal
   * step. Asserts the runner (a) abandons the hung step at the deadline,
   * (b) still fires the terminal step's synchronous side effect, and
   * (c) always settles within the bounded budget — it never hangs.
   */
  describe('long-chain overall-deadline semantics', () => {
    /**
     * Mirror of the overall-deadline value a consumer arms (e.g. `@oxyhq/services`
     * cold boot — the only consumer that arms the deadline). Kept as a local
     * literal because core does not — and must not — import a consumer package;
     * if the consumer's value changes, update this to match.
     */
    const OVERALL_DEADLINE = 20000;

    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    });

    /** A step whose `run()` never settles — models a hung async call. */
    const neverSettlingStep = (): ColdBootStep<TestSession> => ({
      id: 'never-settles',
      run: () => new Promise<ColdBootStepResult<TestSession>>(() => {}),
    });

    it('abandons the hung step at the deadline and fires the terminal step', async () => {
      const terminalRan = jest.fn();
      const onStepDeadline = jest.fn();

      const outcomePromise = runColdBoot<TestSession>({
        overallDeadlineMs: OVERALL_DEADLINE,
        onStepDeadline,
        steps: [
          neverSettlingStep(),
          // Every intermediate step has nothing to contribute on this load.
          skipStep('intermediate-1'),
          skipStep('intermediate-2'),
          skipStep('intermediate-3'),
          {
            id: 'terminal',
            // Runs a synchronous side effect before its first await.
            run: async (): Promise<ColdBootStepResult<TestSession>> => {
              terminalRan();
              return { kind: 'skip' };
            },
          },
        ],
      });

      // Nothing settles before the deadline — the chain is stuck on the first step.
      await jest.advanceTimersByTimeAsync(OVERALL_DEADLINE - 1);
      expect(terminalRan).not.toHaveBeenCalled();

      // At the deadline the hung step is abandoned and the chain proceeds.
      await jest.advanceTimersByTimeAsync(1);
      const outcome = await outcomePromise;

      expect(onStepDeadline).toHaveBeenCalledWith('never-settles');
      expect(terminalRan).toHaveBeenCalledTimes(1);
      expect(outcome).toEqual({ kind: 'unauthenticated' });
    });

    it('settles within the bounded budget instead of hanging forever', async () => {
      let settled = false;
      const outcomePromise = runColdBoot<TestSession>({
        overallDeadlineMs: OVERALL_DEADLINE,
        steps: [neverSettlingStep(), skipStep('terminal')],
      }).then((o) => {
        settled = true;
        return o;
      });

      // Just before the deadline: still pending (proves the deadline, not an
      // accidental early settle, is what unblocks it).
      await jest.advanceTimersByTimeAsync(OVERALL_DEADLINE - 1);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      await outcomePromise;
      expect(settled).toBe(true);
    });

    it('does not penalize a fast first-step success — it wins well before the deadline', async () => {
      const laterRan = jest.fn();
      const outcomePromise = runColdBoot<TestSession>({
        overallDeadlineMs: OVERALL_DEADLINE,
        steps: [
          {
            id: 'first',
            run: async (): Promise<ColdBootStepResult<TestSession>> => {
              await Promise.resolve();
              return { kind: 'session', session: { userId: 'u-fast' } };
            },
          },
          sessionStep('terminal', 'u-should-not-run', laterRan),
        ],
      });

      await jest.advanceTimersByTimeAsync(0);
      const outcome = await outcomePromise;

      expect(outcome).toEqual({
        kind: 'session',
        via: 'first',
        session: { userId: 'u-fast' },
      });
      expect(laterRan).not.toHaveBeenCalled();
    });
  });
});
