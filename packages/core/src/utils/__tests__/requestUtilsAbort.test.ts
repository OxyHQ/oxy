/**
 * Abort awareness in the request queue and the deduplicator.
 *
 * Neither used to know about cancellation, and each turned that into a
 * different bug:
 *
 * - `RequestQueue` never dropped a queued entry whose caller had cancelled, so
 *   a burst of abandoned work (a search box being typed into) occupied every
 *   one of the ten slots while the ONE request the viewer was waiting on
 *   queued behind it. Refusing to RETRY a cancellation stops making more
 *   zombies; this is what returns the slots.
 * - `RequestDeduplicator` handed every caller on a key the same promise, so one
 *   caller's abort rejected all the others — including ones that never
 *   cancelled anything and had no way to know the failure was not theirs.
 */
import { RequestDeduplicator, RequestQueue } from '../requestUtils';
import { ErrorCodes } from '../errorUtils';

const aborted = (): AbortSignal => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};

describe('RequestQueue abort awareness', () => {
  it('never runs a request whose caller already cancelled', async () => {
    const queue = new RequestQueue(2);
    const run = jest.fn(async () => 'ran');

    await expect(queue.enqueue(run, aborted())).rejects.toMatchObject({
      code: ErrorCodes.CANCELLED,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps slots free for a live request when the queue is full of cancelled ones', async () => {
    const queue = new RequestQueue(2);
    let liveRan = false;

    // Six abandoned requests against a two-slot pool. If any of them took a
    // slot and held it, the live request below could never run.
    const dead = Array.from({ length: 6 }, () =>
      queue
        .enqueue(() => new Promise<string>(() => { /* would never settle */ }), aborted())
        .catch(() => 'cancelled'),
    );
    await Promise.all(dead);

    await expect(
      queue.enqueue(async () => { liveRan = true; return 'live'; }),
    ).resolves.toBe('live');
    expect(liveRan).toBe(true);
  });

  it('drops a queued entry that is cancelled while it waits for a slot', async () => {
    const queue = new RequestQueue(1);
    const started: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = queue.enqueue(async () => {
      started.push('first');
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return 'first';
    });

    // The pool is full, so this one sits in the queue rather than starting.
    const controller = new AbortController();
    const second = queue.enqueue(async () => {
      started.push('second');
      return 'second';
    }, controller.signal);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toEqual(['first']);

    // Cancelled while queued: it must never start, not merely be ignored once
    // it finishes. A request can sit here as long as the slots stay busy, which
    // is exactly when the caller is most likely to have moved on.
    controller.abort();
    await expect(second).rejects.toMatchObject({ code: ErrorCodes.CANCELLED });

    releaseFirst?.();
    await expect(first).resolves.toBe('first');
    expect(started).toEqual(['first']);
  });

  it('still decrements its running count when a started request is aborted', async () => {
    const queue = new RequestQueue(1);
    const controller = new AbortController();

    // An entry that has already started is left to its own abort domain: the
    // queue must still observe it finishing, or `running` never comes back down
    // and the slot is leaked permanently.
    const inflight = queue.enqueue(
      () => new Promise<string>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(inflight).rejects.toBeDefined();

    await expect(queue.enqueue(async () => 'after')).resolves.toBe('after');
  });
});

describe('RequestDeduplicator abort awareness', () => {
  it('shares one in-flight request across callers', async () => {
    const dedupe = new RequestDeduplicator();
    const work = jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'shared';
    });

    const [a, b] = await Promise.all([
      dedupe.deduplicate('key', work),
      dedupe.deduplicate('key', work),
    ]);

    expect(a).toBe('shared');
    expect(b).toBe('shared');
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('lets one caller cancel without rejecting the others', async () => {
    const dedupe = new RequestDeduplicator();
    const work = jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return 'shared';
    });

    const cancelling = new AbortController();
    const first = dedupe.deduplicate('key', work, cancelling.signal);
    const second = dedupe.deduplicate('key', work, new AbortController().signal);

    const firstAssertion = expect(first).rejects.toMatchObject({ code: ErrorCodes.CANCELLED });
    cancelling.abort();
    await firstAssertion;

    // The caller that never cancelled anything still gets its answer.
    await expect(second).resolves.toBe('shared');
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('refuses a caller whose signal is already aborted without starting work', async () => {
    const dedupe = new RequestDeduplicator();
    const work = jest.fn(async () => 'shared');

    await expect(dedupe.deduplicate('key', work, aborted())).rejects.toMatchObject({
      code: ErrorCodes.CANCELLED,
    });
    expect(work).not.toHaveBeenCalled();
  });
});
