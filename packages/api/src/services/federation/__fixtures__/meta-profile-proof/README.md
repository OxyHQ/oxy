# Reviewed Meta profile proof fixtures

Captured on 2026-09-13 using ordinary unauthenticated HTTPS GETs of
`https://www.instagram.com/zuck/` and `https://www.threads.com/@zuck`. Both returned
200. These reduced fixtures retain the actual profile-owner Relay query names,
object paths, namespace-specific IDs, and the DOM nesting around the platform
profile badges. Styling, SVG paths, image URLs, counts, posts, and all session,
request, cookie and configuration data were removed. Empty structural slots
remain so that tests exercise the observed control positions rather than invent
an identity field. No raw response HTML is committed or persisted at runtime.

The Instagram response identifies `xig_user_by_username` in the specific logged
out profile-root query: `pk=314216`, graph `id=17841401746480004`. Its Threads
badge occupies a dedicated slot between the profile name and biography in the
profile's `main > header` section. The separate editable website uses the
Instagram outbound link redirect and occupies a later slot.

The Threads response identifies `data.user` in the profile-page root query:
`pk=id=63055343223`. Its Instagram badge sits in the profile-header footer control
row, outside the preceding biography/link slots and before sibling follow,
profile tabs, and post timeline sections. The owner heading and owner-specific
Replies tab bind that panel to the fetched profile. Only that branded SVG badge
in that reviewed control slot is accepted. A matching link elsewhere on the page
is not evidence. Tests move the exact badge into biography, navigation, and post
content, and inject unrelated or conflicting profile payloads.

This is a reviewed first-party HTML layout, not a documented permanent API
contract. Layout or payload changes must fail closed and be reviewed against a
fresh source capture. Display names bind a DOM panel to its own structured owner;
they do not establish that two different accounts belong to the same person.
Account pairing requires two fresh, reciprocal platform-control badges. Handles
may differ. These IDs retain separate namespaces; no equality with an ActivityPub
URI's numeric suffix is inferred. The caller must separately establish Threads
WebFinger/verified ActivityPub binding and decide whether historic bridge rows
have sufficient provenance to participate. Badges do not authorize irreversible
migration of old bridge history.
