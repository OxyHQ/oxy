/**
 * Cross-serializer identity drift-guard.
 *
 * Three serializers turn a `User` into a DTO and historically diverged on `id`
 * (`services/user.service.ts` once used `id = publicKey || _id`, which made a
 * user's posts vanish the moment they linked a Commons key — the whole social
 * graph keys on `_id`). Option 1 of the hardening extracts ONE shared definer,
 * `userIdentityFields`, that every serializer MUST call for the load-bearing
 * `id` / `name` / `username` / `avatar` fields.
 *
 * This test asserts that all THREE serializers — the self/public
 * `utils/userTransform.formatUserResponse`, the public + private
 * `UserService.formatUserResponse` (including its `includePrivateFields`
 * /users/me variant), and the recommendation `routes/profiles.formatProfileResult`
 * — emit IDENTICAL `id`/`name`/`username`/`avatar` for the same input User, and
 * that each equals the shared base. This makes the id-divergence bug structurally
 * impossible: any serializer that stops delegating to `userIdentityFields` breaks
 * this guard.
 */


import { randomBytes } from 'node:crypto';
import { formatUserResponse, userIdentityFields, deriveIsFederated } from '../userTransform';
import { userService } from '../../services/user.service';
import { formatProfileResult } from '../../routes/profiles';

describe('shared identity base — all three user-DTO serializers agree', () => {
  const _id = randomBytes(12).toString('hex');
  const input = {
    _id,
    // A key-anchored account: once linked, `id` MUST stay the ObjectId, not this.
    publicKey: '048295c4a1b2c3d4e5f6a7b8c9d0e1f2',
    username: 'nate',
    name: { first: 'Nate', last: 'Rivera' },
    avatar: 'file-abc123',
  } as const;

  // The single definer the three serializers delegate to.
  const base = userIdentityFields(input);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cross-shape fixture; ts-jest does not type-check tests
  const self = formatUserResponse(input);
  const publicDto = userService.formatUserResponse(input as never);
  const privateDto = userService.formatUserResponse(input as never, undefined, {
    includePrivateFields: true,
  });
  const recommendation = formatProfileResult(input as never);

  it('resolves id to the stable _id string, never the publicKey', () => {
    expect(base.id).toBe(_id.toString());
    expect(base.id).not.toBe(input.publicKey);
  });

  it('all three serializers produce an identical id', () => {
    expect(self?.id).toBe(base.id);
    expect(publicDto.id).toBe(base.id);
    expect(privateDto.id).toBe(base.id);
    expect(recommendation.id).toBe(base.id);
  });

  it('all three serializers produce an identical username', () => {
    expect(self?.username).toBe(base.username);
    expect(publicDto.username).toBe(base.username);
    expect(privateDto.username).toBe(base.username);
    expect(recommendation.username).toBe(base.username);
    expect(base.username).toBe('nate');
  });

  it('all three serializers produce an identical avatar', () => {
    expect(self?.avatar).toBe(base.avatar);
    expect(publicDto.avatar).toBe(base.avatar);
    expect(privateDto.avatar).toBe(base.avatar);
    expect(recommendation.avatar).toBe(base.avatar);
    expect(base.avatar).toBe('file-abc123');
  });

  it('all three serializers produce an identical (composed) name', () => {
    expect(base.name).toEqual({ first: 'Nate', last: 'Rivera', full: 'Nate Rivera', displayName: 'Nate Rivera' });
    expect(self?.name).toEqual(base.name);
    expect(publicDto.name).toEqual(base.name);
    expect(privateDto.name).toEqual(base.name);
    expect(recommendation.name).toEqual(base.name);
  });

  it('the private /users/me variant only ADDS private fields — identity fields are unchanged', () => {
    expect(privateDto.id).toBe(publicDto.id);
    expect(privateDto.username).toBe(publicDto.username);
    expect(privateDto.avatar).toBe(publicDto.avatar);
    expect(privateDto.name).toEqual(publicDto.name);
  });

  it('rejects legacy schema-transform ids that folded publicKey into id', () => {
    const transformed = {
      id: input.publicKey,
      publicKey: input.publicKey,
      username: input.username,
      name: input.name,
      avatar: input.avatar,
    };

    expect(userIdentityFields(transformed).id).toBeUndefined();
    expect(formatUserResponse(transformed)).toBeNull();
  });
});

describe('shared deriveIsFederated — the public and recommendation serializers agree', () => {
  it('derives federated iff type === "federated"', () => {
    expect(deriveIsFederated('federated')).toBe(true);
    expect(deriveIsFederated('local')).toBe(false);
    expect(deriveIsFederated(undefined)).toBe(false);
  });

  it('both serializers that emit isFederated derive it identically', () => {
    const federated = { _id: randomBytes(12).toString('hex'), username: 'remote', type: 'federated' };
    const local = { _id: randomBytes(12).toString('hex'), username: 'local', type: 'local' };

    expect(userService.formatUserResponse(federated as never).isFederated).toBe(true);
    expect(formatProfileResult(federated as never).isFederated).toBe(true);

    expect(userService.formatUserResponse(local as never).isFederated).toBe(false);
    expect(formatProfileResult(local as never).isFederated).toBe(false);
  });
});
