# Final candidate CI fixture corrections

Candidate d8f87 failed Apps/Platform/API4 and scaffold checks on four stale or overly broad fixture assumptions. The fixtures now assert the second exchange option, recognize the exact opaque Capability JWS grammar, expect all six reviewed Mercaria scopes, and use fixture labels that do not add an unrelated Ionicons glyph. Enforcement and fonts do not change.

Scoped local checks pass: Services 13 tests, username census 5, registry SQL fixture 54 after normal fresh141/repeat migrations, icon subsets, build and lint. The owned PostgreSQL process was stopped. [proof.json](proof.json) records exact sources and command outputs. The native resume proof separately records the final complete Services 113/1,036 run and rebuild. Full CI of the next head remains pending; the Forge audit intentionally remains inactive before final freeze.
