# Mention preflight protocol and dispatch intent

Source `4d24c47088aea65bc65d71297205055f54d6fba6` corrects the predecessor result kind. Twelve offline fixtures pass. The actual reader Node encoder feeds the actual Python decoder and complete execute path; only AWS responses are synthetic. No database client or AWS write runs. Restoring the old result kind gives three failures with the same fixtures; source is restored exactly.

The dispatch attempt is private and fsynced before RunTask, whose client token is the full plan nonce. An unknown ACK triggers bounded metadata reconciliation and exact definition/startedBy matching. Zero matches remain unresolved; one or multiple exact matches are cleaned up. All unknown-ACK cases still fail and require operator review; no second RunTask executes. A fresh definition in a later attempt cannot silently use the same client token with changed parameters.

The first fixture execution failed because its synthetic terminal CloudWatch page repeated events. The mock now returns an empty terminal page, preserving real duplicate-packet rejection. This initial fixture error is retained separately from the old-kind mutant.

The previous plan SHA `1a957487524a9282313fa65bffc44e82f05cd259260ec2be5513800c2ed7e4bf` is invalidated. A new exact plan needs operator review before dispatch. This checkpoint does not establish live AWS dispatch, IAM permissions, SQL inventory or a capability CAS.

Reproduce: `PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/agency/test-mention-foreground-preflight.py`.
