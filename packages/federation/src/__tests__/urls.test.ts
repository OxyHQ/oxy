import { INSTANCE_ACTOR_USERNAME, createUrlBuilders, normalizeActorUsername } from '../urls';

describe('normalizeActorUsername', () => {
  it('trims and lowercases mixed-case usernames', () => {
    expect(normalizeActorUsername('  Alice  ')).toBe('alice');
  });
});

describe('INSTANCE_ACTOR_USERNAME', () => {
  // The literal is a WIRE contract: remote instances have already cached
  // `acct:instance@<domain>` and the actor uri built from it. Changing it
  // silently breaks every peer that resolved us before the change.
  it('is the reserved local-part `instance`', () => {
    expect(INSTANCE_ACTOR_USERNAME).toBe('instance');
  });

  it('survives acct local-part normalization unchanged', () => {
    expect(normalizeActorUsername(INSTANCE_ACTOR_USERNAME)).toBe(INSTANCE_ACTOR_USERNAME);
  });

  it('builds the server actor uri under the actor domain', () => {
    expect(createUrlBuilders('mention.earth').actor(INSTANCE_ACTOR_USERNAME)).toBe(
      'https://mention.earth/ap/users/instance',
    );
  });
});
