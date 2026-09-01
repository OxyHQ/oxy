# Changelog: `@oxyhq/node`

## 0.2.0

### Licence: this package moves to the Breathe License 1.0

**Breaking, and a genuine narrowing rather than paperwork.** `@oxyhq/node` is now
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

`@oxyhq/node` has never been published to npm, so no prior release carries an earlier
licence and nobody is affected.

`@oxyhq/node` is below 1.0.0, where semver puts the breaking position in the minor and
`^0.1.0` does not accept `0.2.0`. Bumping the minor is the same signal a major
gives a 1.x package: nobody picks this up without editing their manifest.

### Added

- A `LICENSE` carrying the full Breathe License text with its Parameters filled
  in, and a `NOTICE`.

### Still outstanding

- The Licensor's jurisdiction of incorporation, registration number and the
  governing law are **visible placeholders**. They are not guesses, and must be
  filled in before the commercial arm can invoice.
