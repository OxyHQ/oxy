# Deterministic approval-session race follow-up

Addresses external review https://github.com/OxyHQ/oxy/pull/1557#issuecomment-5965116133. The synthetic earlier bearer middleware observes a live SQL session, commits its revocation or expiry, then invokes next(). The unchanged final approval lookup returns401 INVALID_SESSION and inserts no execution authorization. Missing session ID and nonexistent persisted ID are separate negative cases; prior expiry/inactive and positive origin-person→managed-account cases remain.

All10 tests pass on owned PostgreSQL17 normal migration139. The explicit HTTP server and PostgreSQL close normally; scoped ESLint passes. The middleware/operator boundary is synthetic; session lookup/mutation and authorization SQL are real. No production/cyber/financial effect is claimed. Runtime is unchanged from the accepted d938 route wrapper. Use the same owned rehearsal command as the previous capability rejection proof.
