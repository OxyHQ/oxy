#!/usr/bin/env bun
import { recordScopedLegalReviewMain } from '../src/scripts/recordScopedLegalReview';
recordScopedLegalReviewMain().catch(() => { console.error('Scoped legal review failed; reconcile exact plan and audit before retrying an apply.'); process.exitCode = 1; });
