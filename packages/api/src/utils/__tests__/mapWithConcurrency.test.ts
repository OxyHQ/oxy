import { mapWithConcurrency } from '../mapWithConcurrency';

/** A call the test settles by hand, so the interleaving is the test's to choose. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every pending continuation run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('mapWithConcurrency', () => {
  it('answers in input order whatever order the calls finish in', async () => {
    const calls = [0, 1, 2, 3].map(() => deferred<string>());
    const result = mapWithConcurrency([0, 1, 2, 3], 4, (i) => calls[i].promise);

    calls[3].resolve('d');
    calls[1].resolve('b');
    calls[0].resolve('a');
    calls[2].resolve('c');

    await expect(result).resolves.toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps at most `limit` calls in flight, starting them in order', async () => {
    const started: number[] = [];
    const calls = [0, 1, 2, 3, 4].map(() => deferred<number>());
    const result = mapWithConcurrency([0, 1, 2, 3, 4], 2, (i) => {
      started.push(i);
      return calls[i].promise;
    });

    await flush();
    expect(started).toEqual([0, 1]);

    calls[1].resolve(1);
    await flush();
    expect(started).toEqual([0, 1, 2]);

    calls[0].resolve(0);
    calls[2].resolve(2);
    await flush();
    expect(started).toEqual([0, 1, 2, 3, 4]);

    calls[3].resolve(3);
    calls[4].resolve(4);
    await expect(result).resolves.toEqual([0, 1, 2, 3, 4]);
  });

  it('starts nothing after a failure, waits for what is in flight, then throws the first error', async () => {
    const started: number[] = [];
    const calls = [0, 1, 2, 3].map(() => deferred<number>());
    let settled = false;
    const result = mapWithConcurrency([0, 1, 2, 3], 2, (i) => {
      started.push(i);
      return calls[i].promise;
    }).finally(() => {
      settled = true;
    });
    result.catch(() => undefined);

    calls[0].reject(new Error('first'));
    await flush();
    // Item 1 is still running: the batch has not answered yet.
    expect(settled).toBe(false);
    expect(started).toEqual([0, 1]);

    calls[1].reject(new Error('second'));
    await expect(result).rejects.toThrow('first');
    expect(started).toEqual([0, 1]);
  });

  it('answers an empty list without calling anything', async () => {
    const fn = jest.fn();
    await expect(mapWithConcurrency([], 4, fn)).resolves.toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('treats a limit below one as one', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3], 0, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await flush();
      inFlight--;
      return n;
    });
    expect(peak).toBe(1);
  });
});
