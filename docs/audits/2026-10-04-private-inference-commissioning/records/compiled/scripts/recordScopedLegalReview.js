#!/usr/bin/env bun
"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordScopedLegalReviewMain = recordScopedLegalReviewMain;
/** Plan file contains review metadata only. No bearer or provider credential is accepted. */
const node_fs_1 = require("node:fs");
const postgres_1 = require("../config/postgres");
const scopedLegalReviewOperation_service_1 = require("../services/scopedLegalReviewOperation.service");
function recordScopedLegalReviewMain() {
    return __awaiter(this, arguments, void 0, function* (args = process.argv.slice(2)) {
        const apply = args.length === 3 && args[1] === '--apply';
        if (!(args.length === 1 || apply))
            throw new Error('Usage: record-scoped-legal-review <plan.json> [--apply <plan-sha256>]');
        const plan = JSON.parse((0, node_fs_1.readFileSync)(args[0], 'utf8'));
        yield (0, postgres_1.connectPostgres)();
        try {
            const receipt = yield (0, scopedLegalReviewOperation_service_1.executeScopedLegalReview)(plan, { apply, expectedPlanSha256: apply ? args[2] : undefined });
            console.log(JSON.stringify(receipt));
        }
        finally {
            yield (0, postgres_1.closePostgres)();
        }
    });
}
if (require.main === module)
    recordScopedLegalReviewMain().catch(() => { console.error('Scoped legal review failed; reconcile the exact plan and audit before retrying an apply.'); process.exitCode = 1; });
