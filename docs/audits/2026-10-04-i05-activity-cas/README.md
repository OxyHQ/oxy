I05 configuration now tolerates activity-only xmin changes under the existing application row lock. Every reviewed authority field stays exact; the final CAS uses the revision read while locked. Owner-before-application lock order and credential/binding/closure checks remain unchanged.

Frozen regression: released source fails one activity-only case, with77other tests passing; exact final test bytes pass78SQL tests and3compiled Node controls on an owned fresh142database. Build, scoped ESLint and Biome pass. New semantic application-status drift remains rejected, and canonical rollback is checked.

The live readonly reconciliation established unchanged authority and changed revision after the failed original nonce. It does not establish the original failure cause. No production write, release-image modification, human session or pilot is claimed. Operational staging requires its own reviewed image/module hash binding.
