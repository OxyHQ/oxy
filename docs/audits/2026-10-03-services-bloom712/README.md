# Services with the fixed Bloom 7.1.2 line

Services accepts `>=6.2.1 <6.3.0 || >=7.1.2 <7.2.0`. The root catalog stays at exact published 6.2.1. This admits the reviewed 7.1.2 forward port without admitting the known unfixed 6.3/6.4 or 7.1.1 versions. Consumers choose a single supported Bloom copy; the measured importers resolved the same installed package in each workspace.

The website needs the actual Bloom 7 `agent-avatar`, `project-board`, and `multi-agent-chat` exports. A real Vite build against 6.2.1 failed on those three exports; no demos were removed. Bloom 7.1.2 was built and packed in one command from merged `fb52fa49007f6325a1d802683417d67b1546940b`. It is a candidate here, not a registry publication.

Services builds/types pass. Its 113 Jest suites / 1,038 tests pass, but those tests mock Bloom UI and therefore do not independently prove rendering compatibility. The website supplies the real runtime control: TypeScript, Vite production build, 10 theme tests / 1,812 assertions and Playwright prepaint→React→isolated dark demo→restored light page all pass. The browser observed zero page errors. The generated theme CSS is byte-identical to the website baseline. Full website pre/post-build docs, SEO and routing gates were not run; no deployment claim is made.

All 21,941 tarball files were compared to each of four importers (root and Services in both the SDK and website worktrees). Each pair resolves one Bloom installation. Temporary manifests/locks and resolution evidence are preserved under `inputs`; final source restores the root catalog to 6.2.1 and changes only the Services peer and corresponding lock entry. The packed Services manifest differs from final source only by the explanatory package comment added after tests.

An initial website attempt still had its earlier 6.2.1 override and therefore repeated the missing-export failure; that is retained as setup evidence, not a failed 7.1.2 compatibility result. The final install updates both dependency and override to the measured candidate. No native Metro, Android app, identity store or live API was changed. Native consumers retain their separately accepted 6.2.1 runtime.
