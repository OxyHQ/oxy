import { deriveExternalActorProfile, identityLinks, normalizeExternalBio } from '../externalIdentityPolicy';
import { federationBridges } from '../../../config/federationBridgePolicy';
import { BRIDGED_ACTOR_FIXTURES } from './fixtures/bridgedActors';

const notice = "This account is a replica from Twitter. Its author can't see your replies. If you find this service useful, please consider supporting us via our Patreon.";
const actorUri = 'https://bird.makeup/users/jordievole';
const actor = {
  id: actorUri, preferredUsername: 'jordievole', type: 'Service', name: 'Jordi Évole',
  summary: `<p>Uno @delbarriotv@bird.makeup y de @lodeevole@bird.makeup</p><p>${notice}</p>`,
  attachment: [{ name: 'Official', value: '<a href="https://twitter.com/jordievole" rel="me">Official</a>' }],
};

describe('Oxy external identity policy', () => {
  it('normalizes the first-discovery regression while retaining transport provenance', () => {
    expect(deriveExternalActorProfile(actor, actorUri, 'jordievole@bird.makeup')).toMatchObject({
      username: 'jordievole@x.com', domain: 'x.com', transportAcct: 'jordievole@bird.makeup', actorUri,
      bio: 'Uno @delbarriotv@x.com y de @lodeevole@x.com',
    });
  });

  it('uses the same reviewed mechanism for every captured enabled bridge', () => {
    for (const fixture of BRIDGED_ACTOR_FIXTURES) {
      const result = deriveExternalActorProfile({ id: fixture.actorUri, preferredUsername: fixture.preferredUsername,
        name: fixture.preferredUsername, type: fixture.actorType, summary: fixture.bio,
        attachment: fixture.fields, alsoKnownAs: fixture.alsoKnownAs }, fixture.actorUri);
      const expected = federationBridges.deriveNetworkIdentity(fixture);
      expect(result?.username).toBe(expected?.federatedUsername ?? fixture.acct.toLowerCase());
      expect(result?.domain).toBe(expected?.instanceDomain ?? fixture.host);
    }
  });

  it('does not invent an X identity for the bridge administrator', () => {
    expect(deriveExternalActorProfile({ ...actor, attachment: [], type: 'Person', summary: 'Bridge administrator' }, actorUri))
      .toMatchObject({ username: 'jordievole@bird.makeup', bio: 'Bridge administrator' });
  });

  it('does not accept a caller-provided same-host username for another actor', () => {
    const uri = 'https://social.example/users/bob';
    expect(deriveExternalActorProfile({ id: uri, preferredUsername: 'bob' }, uri, 'alice@social.example'))
      .toMatchObject({ username: 'bob@social.example', transportAcct: 'bob@social.example' });
  });

  it('preserves prose and third-party mentions while qualifying bare and bridge mentions', () => {
    expect(normalizeExternalBio('Mail nate@oxy.so; https://x.com/@name; ping @one and @two@bird.makeup or @three@other.example', 'x.com', 'bird.makeup'))
      .toBe('Mail nate@oxy.so; https://x.com/@name; ping @one@x.com and @two@x.com or @three@other.example');
  });

  it('does not strip similar author-written notices', () => {
    expect(deriveExternalActorProfile({ ...actor, summary: 'This account is a replica from Twitter. My own commentary.' }, actorUri)?.bio)
      .toBe('This account is a replica from Twitter. My own commentary.');
  });

  it('reads explicit rel=me claims, never ordinary links', () => {
    expect(identityLinks("<a href='https://instagram.com/alice' rel='nofollow me'>one</a><a href='https://threads.net/@bob'>two</a>"))
      .toEqual(['https://instagram.com/alice']);
  });
});
