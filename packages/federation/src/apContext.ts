/**
 * The shared JSON-LD `@context` every Oxy app emits on its ActivityPub actor and
 * activity documents.
 *
 * These term declarations are LOAD-BEARING and must stay byte-identical across
 * apps: a strict JSON-LD consumer DROPS any field whose term is not declared
 * here, and Mastodon negative-caches a malformed actor for minutes/hours. The
 * exact set below matches the proven Mention actor — `as:sensitive`, Mastodon's
 * `toot:votersCount`, and the four interoperating quote-post terms
 * (FEP-044f / FEP-e232 across Mastodon, Fedibird, Misskey and Pleroma/Akkoma).
 */
export const AP_CONTEXT = [
  'https://www.w3.org/ns/activitystreams',
  'https://w3id.org/security/v1',
  // The AS2 core context above defines the `as:` prefix
  // (`as` → `https://www.w3.org/ns/activitystreams#`), so this maps the Note's
  // `sensitive` boolean to `as:sensitive` — the exact term Mastodon defines for
  // it. Without the term declaration a JSON-LD consumer drops `sensitive`.
  //
  // `toot` is Mastodon's extension namespace; `votersCount` (the total unique
  // voters on a poll `Question`) is `toot:votersCount` — the exact term Mastodon
  // emits and reads. Without the declaration a JSON-LD consumer drops it. The
  // `Question`/`oneOf`/`anyOf`/`endTime`/`closed` poll terms are all AS2 core, so
  // they need no extra declaration here.
  //
  // Quote-post interop (FEP-044f / FEP-e232). A quote post carries the quoted
  // object's canonical AP id under FOUR terms so the widest set of servers
  // renders the inline quote: `quote` (FEP-044f, Mastodon 4.4+), `quoteUri`
  // (Fedibird), `_misskey_quote` (Misskey) and `quoteUrl` (Pleroma/Akkoma). Each
  // is typed `@id` (an IRI, not a literal); the `misskey`/`fedibird` namespaces
  // and the AS2 `Link` type back the FEP-e232 `Link` quote tag. Without these
  // declarations a strict JSON-LD consumer DROPS the quote fields.
  //
  // `alsoKnownAs` is the account-alias term a Mastodon `Move` verifies. It is
  // `as:alsoKnownAs` typed `@id`, exactly as Mastodon declares it; without the
  // declaration a strict consumer drops the aliases and the move is refused.
  {
    alsoKnownAs: { '@id': 'as:alsoKnownAs', '@type': '@id' },
    sensitive: 'as:sensitive',
    toot: 'http://joinmastodon.org/ns#',
    votersCount: 'toot:votersCount',
    misskey: 'https://misskey-hub.net/ns#',
    fedibird: 'http://fedibird.com/ns#',
    quote: { '@id': 'https://w3id.org/fep/044f#quote', '@type': '@id' },
    quoteUri: { '@id': 'fedibird:quoteUri', '@type': '@id' },
    quoteUrl: { '@id': 'as:quoteUrl', '@type': '@id' },
    _misskey_quote: { '@id': 'misskey:_misskey_quote', '@type': '@id' },
    Link: 'as:Link',
  },
];
