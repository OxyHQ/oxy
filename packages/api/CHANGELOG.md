# Changelog: `@oxyhq/api`

## 2.0.0

### Licence: this package moves to the Breathe License 1.0

**Breaking, and a genuine narrowing rather than paperwork.** `@oxyhq/api` is now
licensed under the Breathe License 1.0, identifier `LicenseRef-Breathe-1.0`. The
code, the API surface and the behaviour are unchanged in this release; it exists
to carry the licence change.

What changes for you:

- **Non commercial use stays free**, perpetually and irrevocably while you comply.
- **Commercial use now requires a paid licence.** The trigger is revenue, and it
  includes purely internal use inside a business that earns revenue.
- **If you deploy it, you publish the corresponding source.** That binds everyone,
  including paying customers, and cannot be bought out of.
- **Attribution is required of everyone** and cannot be waived.
- **Cooperatives, nonprofits, educational institutions, public bodies and worker
  owned businesses pay no fee.**

This is **source available, not open source**. It fails clause 6 of the Open
Source Definition because commercial use is conditional on payment. Automated
licence scanners report it as unknown, and GitHub shows it as "Other".

**Nothing here is retroactive, and it could not be.** `@oxyhq/api@1.0.3` was published
under MIT and stays MIT forever for anyone who has it. They may keep
using it, commercially, at no charge, indefinitely, and may fork it. A licence
change binds future versions only.

### `@oxyhq/db` had to move too

The Breathe License is **not compatible with the GPL or the AGPL**, in either
direction. `@oxyhq/api` imports `@oxyhq/db` in process, and `@oxyhq/db` was
`AGPL-3.0-only`, so relicensing this package alone would have produced a
combination distributable under neither licence. Oxy owns both, so this is a
decision rather than a negotiation, but it IS a decision the migration plan
never made: `@oxyhq/db` postdates that analysis and sits in no layer.

### `NOTICE` now carries real third party obligations

Attribution binds everyone under this licence, so `NOTICE` matters here in a way
it did not before. It records the bundled **GPL-3.0-or-later ffmpeg** binary (an
`optionalDependency` invoked as a separate process, which is aggregation rather
than linking, plus the source offer the GPL requires), the
**LGPL-3.0-or-later** native imaging library sharp loads, with its relinking
statement, and the elections on `node-forge`, `jszip` and `@zone-eu/mailsplit`,
where the alternative in each case is a GPL licence this package cannot accept.

**The standing rule that follows:** if anyone ever links ffmpeg, or any other GPL
library, INTO this process, the combination becomes a GPL derivative and this
package can no longer be distributed under these terms at all.

The major is bumped rather than the change being slipped into a patch. A licence
narrowing must never reach anyone through a routine install.

### Added

- A `LICENSE` carrying the full Breathe License text with its Parameters filled
  in, and a `NOTICE`.

### Still outstanding

- The Licensor's jurisdiction of incorporation, registration number and the
  governing law are **visible placeholders**. They are not guesses, and must be
  filled in before the commercial arm can invoice.
