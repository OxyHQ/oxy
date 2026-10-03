# Combined native recovery and raw HTTP checks

Source `9e07f55c522655e52c805244799d86dd7cffeb7c` composes the reviewed native holder recovery with raw responses, context epoch guards, request-local AbortSignal waits and the verified Bloom peer lines. All 19 recorded source files are byte-identical to their accepted upstream commits.

The final build and package suites passed: core 183 suites / 2228 tests, Services 113 / 1040, provider AppState fixture 32, and real HTTP/PostgreSQL recovery four cases with normal migration 142 fresh/repeat. The PostgreSQL process stopped and both its process and postmaster.pid are absent. Source and built module hashes bind the API test to this combined core distribution. The baseline before the request cancellation followup remains historical.

The provider test drives actual AppState subscriptions and their installed handler while its mint transport is a fixture. The API suite uses actual device routes/services and PostgreSQL, including invalid_device_secret after full/last-account logout, partial logout and proved warm re-login. Android acceptance of the two preserved RED cases remains pending until root executes freshly frozen bundles. No final registry or production claim is made.

Raw request abort cancels only the caller's wait, preserving shared refresh for other callers. Stream cancellation after a Response is delivered remains the consumer's responsibility. Native/catalog Bloom remains 6.2.1; the peer also admits the independently verified 7.1.2 maintenance line.
