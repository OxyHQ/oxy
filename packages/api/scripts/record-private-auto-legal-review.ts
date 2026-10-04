#!/usr/bin/env bun
import { recordPrivateAutoLegalReviewMain } from '../src/scripts/recordPrivateAutoLegalReview';
recordPrivateAutoLegalReviewMain().catch(() => { console.error('Private Auto legal review failed; reconcile exact plan and audit before retrying an apply.'); process.exitCode = 1; });
