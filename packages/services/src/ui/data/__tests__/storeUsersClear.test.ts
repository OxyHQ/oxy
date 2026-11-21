/**
 * `storeUsers` — DELIBERATE CLEARS vs sparse sources.
 *
 * `storeUsers` refuses an empty incoming value so a sparse feed/post/list
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
 * what pins the guard; `storeUsers.test.ts` keeps its own anti-degradation
 * coverage independently.
 */

import { setActiveStore, Store } from '@oxy.so/bloom-data';
import { storeUsers, User } from '../user';
import {
  CLEARABLE_USER_FIELDS,
  type CacheableUser,
  type ClearableUserField,
  clearedFieldsFromAccountUpdate,
  clearedFieldsFromProfileUpdate,
} from '../userRecord';

const readById = (id: string) => User.get(id);

/** A warm, fully-populated record — what an authoritative profile read stored. */
function seedFullEntry(): void {
  setActiveStore(new Store());
  storeUsers({
    id: 'u1',
    username: 'alice',
    name: { displayName: 'Alice A', first: 'Alice' },
    avatar: 'file_old',
    bio: 'old bio',
    description: 'old description',
    color: 'teal',
    accountCategories: ['agency'],
    _count: { followers: 10, following: 5 },
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
  setActiveStore(new Store());
});

describe('storeUsers — a declared clear empties the field', () => {
  it.each(
    CLEARABLE_USER_FIELDS.filter(
      (field): field is Exclude<ClearableUserField, 'name.displayName'> =>
        field !== 'name.displayName',
    ),
  )('drops a stale `%s` only when the caller declares it cleared', (field) => {
    // WITHOUT the declaration: the guard holds, the stored value survives.
    seedFullEntry();
    storeUsers(clearedResponse);
    expect(readById('u1')?.[field]).toBeDefined();

    // WITH it: the same payload now empties exactly that field.
    seedFullEntry();
    storeUsers(clearedResponse, { cleared: [field] });
    expect(readById('u1')?.[field]).toBeUndefined();
  });

  // Three `name` shapes, because `mergeName` branches on them and a single
  // fixture leaves one branch untested (mutation-verified): the measured
  // response carries `name: {}`, a request echo carries `name: {displayName:''}`,
  // and a caller passing a bare object carries no `name` key at all.
  it.each([
    ['present but empty (the measured oxy-api shape)', clearedResponse],
    ['an explicit empty displayName (the request shape)', clearedByEmptyString],
    ['no `name` key at all', { id: 'u1', username: 'alice' } as CacheableUser],
  ])('drops a stale display name only when declared — incoming name %s', (_label, incoming) => {
    seedFullEntry();
    storeUsers(incoming);
    expect(readById('u1')?.name).toEqual({
      displayName: 'Alice A',
      first: 'Alice',
    });

    seedFullEntry();
    storeUsers(incoming, { cleared: ['name.displayName'] });
    // `first` is not what was cleared and must survive — a clear is per-field,
    // not "drop the whole `name` object".
    expect(readById('u1')?.name).toEqual({ first: 'Alice' });
  });

  it('never lets the "Unknown user" sentinel survive a declared display-name clear', () => {
    // The ghost-author sentinel is not a real value, so it must not block the
    // clear either — it is "empty" for this purpose, exactly as it is for the
    // anti-degradation guard.
    seedFullEntry();
    storeUsers(
      { id: 'u1', username: 'alice', name: { displayName: 'Unknown user' } },
      { cleared: ['name.displayName'] },
    );
    expect(readById('u1')?.name).toEqual({ first: 'Alice' });
  });

  it('clears ONLY the declared fields, leaving every other one intact', () => {
    seedFullEntry();
    storeUsers(clearedResponse, { cleared: ['avatar'] });

    const entry = readById('u1');
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
    seedFullEntry();
    storeUsers(clearedResponse, { cleared: [...CLEARABLE_USER_FIELDS] });

    expect(readById('u1')?.relationship).toEqual({ isFollowing: true, followsYou: true });
    expect(readById('u1')?.username).toBe('alice');
  });
});

describe('storeUsers — a declared clear never beats a real value', () => {
  it('keeps a meaningful incoming value for a field declared cleared', () => {
    // The server-COMPOSED display name case: clearing the EXPLICIT name makes
    // oxy-api return the composed one, which must be stored rather than
    // blanked. Same rule for every field: `cleared` lowers the guard, it does
    // not force an erasure.
    seedFullEntry();
    storeUsers(
      {
        id: 'u1',
        username: 'alice',
        name: { displayName: 'Alice Anderson' },
        avatar: 'file_new',
      },
      { cleared: ['name.displayName', 'avatar'] },
    );

    expect(readById('u1')?.name).toEqual({
      displayName: 'Alice Anderson',
      first: 'Alice',
    });
    expect(readById('u1')?.avatar).toBe('file_new');
  });

  it('treats an explicit null and an empty string as cleared, not as values', () => {
    // oxy-api omits a cleared field, but `UpdateAccountInput` clears with `null`
    // and `UserProfileUpdate` clears with `''`, so a caller echoing its own
    // request must land on the same result as one passing the response.
    for (const empty of [null, '', '   ']) {
      seedFullEntry();
      storeUsers({ id: 'u1', username: 'alice', avatar: empty }, { cleared: ['avatar'] });
      expect(readById('u1')?.avatar).toBeUndefined();
    }
  });

  it('stores a person not held yet as they came (nothing stale to drop)', () => {
    storeUsers(clearedResponse, { cleared: ['avatar'] });

    expect(readById('u1')).toMatchObject({ id: 'u1', username: 'alice' });
    expect(readById('u1')?.avatar).toBeUndefined();
  });
});

describe('storeUsers — a batch stays guarded', () => {
  it('never empties a field without a declaration', () => {
    // A batch is a multi-user projection: exactly the sparse source the guard
    // exists for.
    seedFullEntry();

    storeUsers([{ id: 'u1', username: 'alice', avatar: null }]);

    expect(readById('u1')?.avatar).toBe('file_old');
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
