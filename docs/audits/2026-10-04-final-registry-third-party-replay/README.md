# Published SDK third-party browser replay

The real registered third-party application completed cancellation, password/account selection, OAuth authorization and token exchange, fresh profile reads, grant removal followed by a real consent prompt, and same-subject consent. Choosing the organization in consent initiated by the person was rejected; a fresh profile request still returned the original person. Logout and reload stayed signed out, with zero cookies.

Browser-only routing served exact hashed registry-build assets on the registered17962 origin from an owned temporary17979 transport. Callback queries were not forwarded to that transport. API/IdP/auth requests were not rewritten or fulfilled. Chromium required the isolated origin’s local-network permission because of routed navigation. Both browser and temporary server were closed; shared supervisors and listeners were preserved. This is a declared test-transport limitation, not production deployment evidence.

[Proof](proof.json) pins108 built files,916 registry module paths, source/lock/importer verification, served response hashes, observations and retained setup failures. Grant removal did not itself invalidate the already-issued profile session; no stronger revocation claim is made.
