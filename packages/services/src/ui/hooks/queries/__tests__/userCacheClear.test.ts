/**
 * userCache — DELIBERATE CLEARS vs sparse sources.
 *
 * `upsertCachedUser` refuses an empty incoming value so a sparse feed/post/list
 * author can never blank a field the authoritative profile fetch stored. That is
 * right for a projection and wrong for a user who just removed their picture,
 * and the payload cannot tell the two apart: oxy-api's `formatUserResponse`
 * emits a cleared field as `undefined`, which `JSON.stringify` drops, so a
 * cleared avatar and an uncarried one arrive byte-identical. The caller declares
 * the difference with `{ cleared: [...] }`.
 *
 * WHAT MAKES THIS SUITE NON-VACUOUS
 * ---------------------------------
 * Every assertion here is paired: the SAME incoming payload is upserted once
 * WITHOUT `cleared` and once WITH it, and the two must disagree. A suite whose
 * fixtures only ever passed `cleared` could not tell "the guard was removed"
 * from "the clear works", which is the whole risk — dropping the guard would
 * blank real avatars across every Oxy app. The `does not` half of each pair is
 * what pins the guard; `userCache.test.ts` keeps its own anti-degradation
 * coverage independently.
 */

import { QueryClient } from '@tanstack/react-query';
import {
  CLEARABLE_USER_FIELDS,
  clearedFieldsFromAccountUpdate,
  clearedFieldsFromProfileUpdate,
  upsertCachedUser,
  upsertCachedUsers,
} from '../userCache';
import type { CacheableUser, ClearableUserField } from '../userCache';
import { queryKeys } from '../queryKeys';
import { useAuthStore } from '../../../stores/authStore';

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function readById(qc: QueryClient, id: string): CacheableUser | undefined {
  return qc.getQueryData<CacheableUser>(queryKeys.users.detail(id));
}

function readByUsername(
  qc: QueryClient,
  username: string,
  viewerId: string,
): CacheableUser | undefined {
  return qc.getQueryData<CacheableUser>(
    queryKeys.users.byUsername(username, viewerId),
  );
}

/** A warm, fully-populated entry — what an authoritative profile fetch stored. */
function seedFullEntry(qc: QueryClient, viewerId = ''): void {
  const full = {
    id: 'u1',
    username: 'alice',
    name: { displayName: 'Alice A', first: 'Alice' },
    avatar: 'file_old',
    bio: 'old bio',
    description: 'old description',
    color: 'teal',
    accountCategories: ['agency'],
    _count: { followers: 10, following: 5 },
  };
  qc.setQueryData(queryKeys.users.detail('u1'), full);
  qc.setQueryData(queryKeys.users.byUsername('alice', viewerId), {
    ...full,
    relationship: { isFollowing: true, followsYou: true },
  });
}

/**
 * The write response for an account that just emptied everything, in the shape
 * oxy-api's `formatUserResponse` actually produces — MEASURED, not assumed:
 *
 *   {"id":"acc1","publicKey":"pk","username":"chan","name":{},"languages":[]}
 *
 * The two details that matter and are easy to get wrong: every cleared scalar is
 * OMITTED (serialized as `undefined`, which `JSON.stringify` drops), while
 * `name` survives as a PRESENT-but-EMPTY object. Writing this fixture as
 * `{ id, username }` instead — with no `name` key — routes `mergeName` down its
 * "incoming absent" branch and leaves the "incoming present, displayName empty"
 * branch untested; mutation-testing caught exactly that. Nothing in this object
 * says "cleared", which is the whole point.
 */
const clearedResponse: CacheableUser = { id: 'u1', username: 'alice', name: {} };

/**
 * The same clear expressed the way a caller echoing its own REQUEST would send
 * it: `UserProfileUpdate` clears a display name with `''`. It must land on the
 * same result as the response shape above.
 */
const clearedByEmptyString: CacheableUser = {
  id: 'u1',
  username: 'alice',
  name: { displayName: '' },
};

beforeEach(() => {
  useAuthStore.setState({ user: null });
});

describe('upsertCachedUser — a declared clear empties the field', () => {
  it.each(
    CLEARABLE_USER_FIELDS.filter(
      (field): field is Exclude<ClearableUserField, 'name.displayName'> =>
        field !== 'name.displayName',
    ),
  )('drops a stale `%s` only when the caller declares it cleared', (field) => {
    // WITHOUT the declaration: the guard holds, the stored value survives.
    const guarded = makeClient();
    seedFullEntry(guarded);
    upsertCachedUser(guarded, clearedResponse, '');
    expect(readById(guarded, 'u1')?.[field]).toBeDefined();

    // WITH it: the same payload now empties exactly that field.
    const cleared = makeClient();
    seedFullEntry(cleared);
    upsertCachedUser(cleared, clearedResponse, '', { cleared: [field] });
    expect(readById(cleared, 'u1')?.[field]).toBeUndefined();
  });

  // Three `name` shapes, because `mergeName` branches on them and a single
  // fixture leaves one branch untested (mutation-verified): the measured
  // response carries `name: {}`, a request echo carries `name: {displayName:''}`,
  // and a caller passing a bare object carries no `name` key at all.
  it.each([
    ['present but empty (the measured oxy-api shape)', clearedResponse],
    ['an explicit empty displayName (the request shape)', clearedByEmptyString],
    ['no `name` key at all', { id: 'u1', username: 'alice' } as CacheableUser],
  ])(
    'drops a stale display name only when declared — incoming name %s',
    (_label, incoming) => {
      const guarded = makeClient();
      seedFullEntry(guarded);
      upsertCachedUser(guarded, incoming, '');
      expect(readById(guarded, 'u1')?.name).toEqual({
        displayName: 'Alice A',
        first: 'Alice',
      });

      const cleared = makeClient();
      seedFullEntry(cleared);
      upsertCachedUser(cleared, incoming, '', {
        cleared: ['name.displayName'],
      });
      // `first` is not what was cleared and must survive — a clear is per-field,
      // not "drop the whole `name` object".
      expect(readById(cleared, 'u1')?.name).toEqual({ first: 'Alice' });
    },
  );

  it('never lets the "Unknown user" sentinel survive a declared display-name clear', () => {
    // The ghost-author sentinel is not a real value, so it must not block the
    // clear either — it is "empty" for this purpose, exactly as it is for the
    // anti-degradation guard.
    const qc = makeClient();
    seedFullEntry(qc);
    upsertCachedUser(
      qc,
      { id: 'u1', username: 'alice', name: { displayName: 'Unknown user' } },
      '',
      { cleared: ['name.displayName'] },
    );
    expect(readById(qc, 'u1')?.name).toEqual({ first: 'Alice' });
  });

  it('clears under the by-username key too, not just by-id', () => {
    const qc = makeClient();
    seedFullEntry(qc, 'viewer-1');
    upsertCachedUser(qc, clearedResponse, 'viewer-1', { cleared: ['avatar'] });

    expect(readByUsername(qc, 'alice', 'viewer-1')?.avatar).toBeUndefined();
    expect(readById(qc, 'u1')?.avatar).toBeUndefined();
  });

  it('clears ONLY the declared fields, leaving every other one intact', () => {
    const qc = makeClient();
    seedFullEntry(qc);
    upsertCachedUser(qc, clearedResponse, '', { cleared: ['avatar'] });

    const entry = readById(qc, 'u1');
    expect(entry?.avatar).toBeUndefined();
    // Vacuity floor: if a clear were implemented as "drop everything absent
    // from the payload", all of these would be gone too and the test above
    // would still pass.
    expect(entry?.bio).toBe('old bio');
    expect(entry?.description).toBe('old description');
    expect(entry?.color).toBe('teal');
    expect(entry?.name).toEqual({ displayName: 'Alice A', first: 'Alice' });
    expect(entry?._count).toEqual({ followers: 10, following: 5 });
  });

  it('never drops the viewer relationship, whatever is declared', () => {
    // `relationship` is not declarable (it is absent from CLEARABLE_USER_FIELDS)
    // and is server-derived, never user-emptied. Dropping it is the
    // "Follows you tag vanishes" bug this module exists to prevent.
    const qc = makeClient();
    seedFullEntry(qc, 'viewer-1');
    upsertCachedUser(qc, clearedResponse, 'viewer-1', {
      cleared: [...CLEARABLE_USER_FIELDS],
    });

    expect(readByUsername(qc, 'alice', 'viewer-1')?.relationship).toEqual({
      isFollowing: true,
      followsYou: true,
    });
    expect(readByUsername(qc, 'alice', 'viewer-1')?.username).toBe('alice');
  });
});

describe('upsertCachedUser — a declared clear never beats a real value', () => {
  it('keeps a meaningful incoming value for a field declared cleared', () => {
    // The server-COMPOSED display name case: clearing the EXPLICIT name makes
    // oxy-api return the composed one, which must be stored rather than
    // blanked. Same rule for every field: `cleared` lowers the guard, it does
    // not force an erasure.
    const qc = makeClient();
    seedFullEntry(qc);

    upsertCachedUser(
      qc,
      {
        id: 'u1',
        username: 'alice',
        name: { displayName: 'Alice Anderson' },
        avatar: 'file_new',
      },
      '',
      { cleared: ['name.displayName', 'avatar'] },
    );

    expect(readById(qc, 'u1')?.name).toEqual({
      displayName: 'Alice Anderson',
      first: 'Alice',
    });
    expect(readById(qc, 'u1')?.avatar).toBe('file_new');
  });

  it('treats an explicit null and an empty string as cleared, not as values', () => {
    // oxy-api omits a cleared field, but `UpdateAccountInput` clears with `null`
    // and `UserProfileUpdate` clears with `''`, so a caller echoing its own
    // request must land on the same result as one passing the response.
    for (const empty of [null, '', '   ']) {
      const qc = makeClient();
      seedFullEntry(qc);
      upsertCachedUser(qc, { id: 'u1', username: 'alice', avatar: empty }, '', {
        cleared: ['avatar'],
      });
      expect(readById(qc, 'u1')?.avatar).toBeUndefined();
    }
  });

  it('is a no-op on a cold slot (nothing stale to drop)', () => {
    const qc = makeClient();
    upsertCachedUser(qc, clearedResponse, '', { cleared: ['avatar'] });

    expect(readById(qc, 'u1')).toMatchObject({ id: 'u1', username: 'alice' });
    expect(readById(qc, 'u1')?.avatar).toBeUndefined();
    // The cold-slot stale-seed contract still holds.
    expect(qc.getQueryState(queryKeys.users.detail('u1'))?.dataUpdatedAt).toBe(0);
  });
});

describe('upsertCachedUsers — the batch path stays guarded', () => {
  it('takes no clear declaration and never empties a field', () => {
    // A batch is a multi-user projection: exactly the sparse source the guard
    // exists for. If it ever grows a `cleared` option this test should fail.
    const qc = makeClient();
    seedFullEntry(qc);

    upsertCachedUsers(qc, [{ id: 'u1', username: 'alice', avatar: null }], '');

    expect(readById(qc, 'u1')?.avatar).toBe('file_old');
  });
});

describe('clearedFieldsFromProfileUpdate', () => {
  it('names only fields the patch deliberately emptied', () => {
    expect(
      clearedFieldsFromProfileUpdate({ avatar: '', bio: '', name: { displayName: '' } }),
    ).toEqual(['avatar', 'bio', 'name.displayName']);
    expect(clearedFieldsFromProfileUpdate({ avatar: 'file_new', bio: 'hello' })).toEqual([]);
    expect(clearedFieldsFromProfileUpdate({ color: null })).toEqual(['color']);
  });
});

describe('clearedFieldsFromAccountUpdate', () => {
  it('treats null clears on managed accounts like profile clears', () => {
    expect(
      clearedFieldsFromAccountUpdate({
        avatar: null,
        bio: null,
        accountCategories: [],
        name: { displayName: '' },
      }),
    ).toEqual(['avatar', 'bio', 'accountCategories', 'name.displayName']);
    expect(clearedFieldsFromAccountUpdate({ bio: 'still here' })).toEqual([]);
  });
});
