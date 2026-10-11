/**
 * Bounded semantic extension of Auto. This module owns neither provider I/O nor
 * a ledger: a child must go through Oxy admission, signing and settlement.
 * Production has no child executor while commercial/privacy review is pending.
 */
import { randomUUID } from 'node:crypto';
import { exactDecimalSchema, modelReferenceSchema } from '@oxy.so/contracts';
import { z } from 'zod';
import type { AutoClassifierReview } from '../config/autoClassification';
import {
  AUTO_POWER_LEVELS,
  classifyAutoPowerLevel,
  type AutoPowerDecision,
  type AutoPowerLevelResolver,
} from './inferencePowerLevels.service';

export const AUTO_CLASSIFIER_LIMITS = Object.freeze({
  timeoutMs: 1_000,
  maxStateBytes: 8_192,
  maxPricePerRequest: Object.freeze({
    currency: 'USD' as const,
    amount: exactDecimalSchema.parse('0.001000000000'),
  }),
});

export const AUTO_CLASSIFIER_VERSION = 'jev-auto-v1';

/**
 * Internal adapter boundary for the typed decisions child.
 * The executor binds the parent's authenticated principal and pinned policy,
 * admits ONE exact-model decisions child under this additional price ceiling,
 * and owns its reservation/settlement even after cancellation. It must never
 * recurse through Auto, retry an uncertain charge, or reserve the parent.
 */
export interface AutoClassificationChild {
  readonly requestId: string;
  readonly parentRequestId: string;
  readonly target: { readonly kind: 'model'; readonly modelReference: string };
  readonly classifierVersion: typeof AUTO_CLASSIFIER_VERSION;
  readonly state: string;
  readonly levels: typeof AUTO_POWER_LEVELS;
  readonly maxPricePerRequest: typeof AUTO_CLASSIFIER_LIMITS.maxPricePerRequest;
  readonly signal: AbortSignal;
  /** Absolute wall-clock deadline fixed when this classifier operation starts. */
  readonly deadlineAt: number;
}

export interface JevAutoClassifier {
  readonly modelReference: string;
  readonly review:
    | AutoClassifierReview
    | {
        readonly purpose: 'private_auto_classifier';
        readonly sourceApprovalSha256: string;
        readonly internalUseAllowed: true;
        readonly commercialUseAllowed: boolean;
        readonly privacy: true;
        readonly zdr: true;
      };
  /** Return a normalized { level, confidence }, never provider reasoning or error text. */
  readonly admitAndExecute: (child: AutoClassificationChild) => Promise<unknown>;
}

/** Both fields come from the provider's typed reply; neither is ever inferred. */
const classificationSchema = z
  .object({
    level: z.enum(AUTO_POWER_LEVELS),
    confidence: z.number().finite().min(0).max(1),
  })
  .strict();

type FallbackReason =
  | 'disabled'
  | 'invalid_model'
  | 'input_limit'
  | 'timeout'
  | 'cancelled'
  | 'provider_error'
  | 'invalid_result';

/**
 * Snapshot configuration at construction; the per-request adapter pins identity
 * and policy before calling this. No result cache, payload persistence or retry.
 * Feature-based floors still apply when semantic classification suggests less.
 */
export function createAutoPowerLevelResolver(
  classifier?: JevAutoClassifier,
): AutoPowerLevelResolver {
  const modelReference = classifier?.modelReference;
  const execute = classifier?.admitAndExecute;
  const review = classifier?.review;
  const reviewed =
    review !== undefined &&
    ('purpose' in review
      ? review.purpose === 'private_auto_classifier' &&
        /^[a-f0-9]{64}$/.test(review.sourceApprovalSha256) &&
        review.internalUseAllowed === true &&
        review.privacy === true &&
        review.zdr === true
      : review.commercial === true &&
        review.internalEligibility === true &&
        review.privacy === true &&
        review.zdr === true);
  const pinned =
    modelReferenceSchema.safeParse(modelReference).success &&
    modelReference?.includes('@') === true;

  return async (features, context) => {
    const deterministic = classifyAutoPowerLevel(features);
    const fallback = (reason: FallbackReason): AutoPowerDecision => ({
      ...deterministic,
      // Fixed codes only. Never forward an exception, payload or provider reason.
      classification: { source: 'deterministic', reason, version: AUTO_CLASSIFIER_VERSION },
    });
    if (!reviewed || execute === undefined || context === undefined) return fallback('disabled');
    if (!pinned || modelReference === undefined) return fallback('invalid_model');
    if (context.signal.aborted) return fallback('cancelled');

    let state: string;
    try {
      state = context.state();
      if (Buffer.byteLength(state, 'utf8') > AUTO_CLASSIFIER_LIMITS.maxStateBytes) {
        return fallback('input_limit');
      }
    } catch {
      return fallback('invalid_result');
    }

    const controller = new AbortController();
    const deadline = performance.now() + AUTO_CLASSIFIER_LIMITS.timeoutMs;
    const deadlineAt = Date.now() + AUTO_CLASSIFIER_LIMITS.timeoutMs;
    type Outcome = { kind: 'result'; value: unknown } | { kind: FallbackReason };
    let finish!: (outcome: Outcome) => void;
    const stopped = new Promise<Outcome>((resolve) => {
      finish = resolve;
    });
    const stop = (kind: 'timeout' | 'cancelled'): void => {
      // Resolve before abort: an adapter may reject synchronously on abort.
      finish({ kind });
      controller.abort();
    };
    const cancel = (): void => stop('cancelled');
    context.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => stop('timeout'), AUTO_CLASSIFIER_LIMITS.timeoutMs);
    try {
      const child: AutoClassificationChild = Object.freeze({
        requestId: randomUUID(),
        parentRequestId: context.requestId,
        target: Object.freeze({ kind: 'model', modelReference }),
        classifierVersion: AUTO_CLASSIFIER_VERSION,
        state,
        levels: AUTO_POWER_LEVELS,
        maxPricePerRequest: AUTO_CLASSIFIER_LIMITS.maxPricePerRequest,
        signal: controller.signal,
        deadlineAt,
      });
      // The microtask also catches a synchronous adapter throw. Both completion
      // handlers stay attached after timeout; late failures cannot be unhandled.
      const execution: Promise<Outcome> = Promise.resolve()
        .then<Outcome>(async () => {
          if (context.signal.aborted) return { kind: 'cancelled' } as const;
          return execute(child).then((value) => ({ kind: 'result', value }) as const);
        })
        .catch(() => ({ kind: 'provider_error' }));
      const outcome = await Promise.race([stopped, execution]);
      if (context.signal.aborted) return fallback('cancelled');
      if (performance.now() >= deadline) {
        controller.abort();
        return fallback('timeout');
      }
      if (outcome.kind !== 'result') return fallback(outcome.kind);
      const parsed = classificationSchema.safeParse(outcome.value);
      if (!parsed.success) return fallback('invalid_result');
      const semantic = parsed.data.level;
      const level =
        AUTO_POWER_LEVELS.indexOf(semantic) > AUTO_POWER_LEVELS.indexOf(deterministic.level)
          ? semantic
          : deterministic.level;
      return {
        level,
        reasons: deterministic.reasons,
        classification: {
          source: 'jev',
          version: AUTO_CLASSIFIER_VERSION,
          modelReference,
          recommendedLevel: semantic,
          providerConfidence: parsed.data.confidence,
        },
      };
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', cancel);
    }
  };
}
