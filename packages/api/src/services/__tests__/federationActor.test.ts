/**
 * `getUserActor` against a REAL Postgres.
 *
 * The suite this replaces mocked `mongoose` wholesale and fed the function an
 * `as never` object, so neither the key lookup nor the actor's own shape was
 * checked against anything. Here the key pair is a real row and the parameter
 * is the declared `ActorSourceUser`, which is what makes the `as never` — and
 * with it the ability to hand this function a shape it cannot serve —
 * unnecessary.
 *
 * MOCKED, because each is a collaborator this file is not about: the asset and
 * S3 services (avatar URL resolution) and `userCache`.
 */

jest.mock('../assetService', () => ({
  __esModule: true,
  AssetService: class {},
}));

jest.mock('../s3Service', () => ({
  createS3Service: jest.fn(),
}));

jest.mock('../../utils/userCache', () => ({
  __esModule: true,
  default: { invalidate: jest.fn() },
}));

import { closePostgres, connectPostgres } from '../../config/postgres';
import { getUserActor, getUserKeyPair, type ActorSourceUser } from '../federation.service';

const DOMAIN = 'mention.earth';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('getUserActor', () => {
  it('lowercases mixed-case usernames in actor id and publicKey.owner', async () => {
    const actor = await getUserActor(
      { username: 'Bob', name: { first: 'Bob', last: 'Example' }, bio: '', kind: 'personal' },
      DOMAIN,
    );

    expect(actor).toMatchObject({
      id: `https://${DOMAIN}/ap/users/bob`,
      preferredUsername: 'bob',
      publicKey: {
        id: `https://${DOMAIN}/ap/users/bob#main-key`,
        owner: `https://${DOMAIN}/ap/users/bob`,
      },
    });
  });

  it('publishes the SAME public key the key store holds for that actor', async () => {
    const actor = await getUserActor({ username: 'grace', kind: 'personal' }, DOMAIN);
    const keyPair = await getUserKeyPair('grace', DOMAIN);

    // The actor document is what remote servers verify signatures against, so a
    // published key that is not the stored one is a silent federation outage.
    expect(actor).toMatchObject({
      publicKey: { id: keyPair.keyId, publicKeyPem: keyPair.publicKeyPem },
    });
  });

  it('maps each account kind onto its ActivityPub actor type', async () => {
    const kinds: Array<[NonNullable<ActorSourceUser['kind']>, string]> = [
      ['personal', 'Person'],
      ['organization', 'Organization'],
      ['project', 'Group'],
      ['bot', 'Service'],
    ];

    for (const [kind, expected] of kinds) {
      const actor = await getUserActor({ username: `kind-${kind}`, kind }, DOMAIN);
      expect(actor).toMatchObject({ type: expected });
    }
  });

  it('falls back to the handle when the account has no real display name', async () => {
    const actor = await getUserActor({ username: 'henry', kind: 'personal' }, DOMAIN);

    // An ActivityPub `name` must be a non-empty string, and the API no longer
    // synthesizes a display name — the handle is the sanctioned fallback.
    expect(actor).toMatchObject({ name: 'henry' });
  });

  it('uses an intentionally cleared bio instead of falling back to legacy description', async () => {
    const actor = await getUserActor(
      { username: 'cleared-bio', bio: '', description: 'legacy text', kind: 'personal' },
      DOMAIN,
    );

    expect(actor).toMatchObject({ summary: '' });
  });

  it('returns null without touching the key store when there is no username', async () => {
    expect(await getUserActor({ kind: 'personal' }, DOMAIN)).toBeNull();
  });
});
