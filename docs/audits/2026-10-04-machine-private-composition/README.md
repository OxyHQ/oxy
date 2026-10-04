# Machine/core4.4 + private commissioning + Mention composition

This local worktree composes frozen root1577 `bf26ba75` with PR1580 `7740c711`, then the five minimal Mention commits below. All merges applied without conflicts. Original PR branches and worktrees remain untouched. No AWS/provider calls, push, publication, activation or new DDL occurred.

Core4.4 and the root package/lock candidate inputs (359 files) are byte-identical to root1577. Its stable claim sorting fixture is also byte-identical. Economic policy `.2`, USD0.05 maximum quote, all four Alia tuples and capacity limits are retained. Mention adds only the reviewed optional relationship budget type to that config. Both source authority getters remain undefined.

The canonical API build succeeded, including all eight direct workspace dependencies. The initial joint run retained a real fixture collision: 9 suites/174 tests passed; the 11 Alia machine HTTP cases failed in setup because another suite had already inserted the canonical Alia application ID in the worker database. It also retained the failed setup cleanup error. No production auth failure is inferred from that RED.

The standalone test-only commit `51ee2bce0c30e2a389f151079c8053716e7c84d5` gives that fixture its own normally migrated database, guarded teardown and restoration of the worker URL. It does not delete another fixture's rows. The two previously colliding HTTP/SQL suites plus machine service and scope tests then passed: 4 suites/117 tests. The other scoped/Mention suites and the static routing-score census had already passed; they were not repeated after this test-only lifecycle fix. Both owned PostgreSQL processes were stopped and their PIDs verified absent. Scoped fixture ESLint passed.

## Minimal eventual replay after PR1580 is on main

Preserve root1577's sorted claims helper and core4.4 package/lock inputs. Replay only:

1. `31ac37824a5624ec1617be9cd9b4e8ac58a42bdd` — inactive Mention relationship source.
2. `f8afaf8c19d950e5ac24271563907627f72aac91` — its source/SQL evidence.
3. `fe2ec3af2f5353eaacdb0563d056c94439be89da` — six-line early funding guard qualification and actual Mention private HTTP/SQL fixture.
4. `1de766c384fc4c43f9a2e7f586f36e4fd99b2ae2` — composed private fixture evidence.
5. `0b4d9b55741a2b944e13eb4ed99977cbf2cab694` — add that fixture's explicitly funded routing-score insert to the static census (19).
6. `51ee2bce0c30e2a389f151079c8053716e7c84d5` — standalone Alia fixture database isolation, unless already applied by root.

This composition is prepared for review only. Root controls eventual PR1578 composition, CI, publication and promotion. No complete core retest is attributed: its source leaves are unchanged from the reviewed root1577 input.
