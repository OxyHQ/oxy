/**
 * A server answer held whole, under the key of the read that returned it.
 *
 * Most SDK reads return records with an id of their own (a person, an
 * organization, a claim), and those go into their entities. Some return one
 * value that is not a record by id: an account's subscription or wallet, its
 * supervision state, a page of a listing shown one page at a time, the people
 * named by a set of ids. Such an answer is held as one `Answer` record whose
 * id is the read's key, so it is read, refreshed, shared between callers and
 * dropped with its account's store like any other record.
 *
 * An answer belongs to its read: once a key's read state is dropped
 * (`gcTime`), a copy still in memory is not shown again until the key has
 * been read again, as the read it came from no longer exists.
 */
import {
  entity,
  type RecordSource,
  type RecordSourceOptions,
  type RecordView,
  type Skip,
  skip,
  source,
  useRecord,
} from '@oxy.so/bloom-data';

export interface Answer<T> {
  /** The key of the read that returned it. */
  readonly id: string;
  readonly value: T;
}

export interface AnswerSourceOptions<A extends unknown[], T>
  extends Omit<RecordSourceOptions<A, Answer<T>>, 'load' | 'index' | 'put'> {
  /** The answer; it is held under `key(...args)`. */
  load: (request: { readonly signal: AbortSignal }, ...args: NoInfer<A>) => Promise<T>;
}

/** A record source whose records are the answers of `load`, one per key. `type` names its entity. */
export function answerSource<A extends unknown[], T>(
  type: string,
  { load, ...options }: AnswerSourceOptions<A, T>,
): RecordSource<A, Answer<T>> {
  return source(entity<Answer<T>>(type, { id: (answer) => answer.id }), {
    ...options,
    load: async (request, ...args) => ({
      id: options.key(...args),
      value: await load(request, ...args),
    }),
  });
}

/**
 * Observes an answer source for `args` (or nothing, with `skip`) and returns
 * the answer as the view's `value`.
 */
export function useAnswer<A extends unknown[], T>(
  answers: RecordSource<A, Answer<T>>,
  ...args: A | [Skip]
): RecordView<T> {
  const view = useRecord(answers, ...args);
  const observed = args[0] !== skip;
  const read = view.status === 'success' || view.status === 'error';
  return {
    ...view,
    value: read ? view.value?.value : undefined,
    isLoading: observed && !read,
    isFetching: view.fetchStatus === 'fetching' || (observed && view.status === 'idle'),
  };
}
