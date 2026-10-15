/**
 * How a grant is treated economically.
 *
 * The treatment is decided by Oxy from the AUTHENTICATED application, its
 * environment and lane, against a versioned policy; nothing a caller sends can
 * select it, so it appears only on the signed grant, never on a public request.
 *
 * Moved from `@oxy.so/contracts` 4.12.0 (`src/inference/economics.ts`) by Kaana
 * ADR 0002, which adds `platform_fee_only` (decision 4: a BYOK request, billed
 * by the provider to the customer, on which Oxy charges only its fee; until now
 * a receipt flag). Cost-centre usage and the metered generation read model stay
 * in `@oxy.so/contracts`.
 */

import { z } from 'zod';

/**
 * - `commercial` — the default: reserve, settle, refund.
 * - `internal_metered` — a product relationship Oxy configured (Alia on Kaana,
 *   the Jev classifier): no hold and no receipt, usage still recorded.
 * - `platform_fee_only` — BYOK: the provider bills the customer's own account.
 */
export const INFERENCE_ECONOMIC_TREATMENTS = [
  'commercial',
  'internal_metered',
  'platform_fee_only',
] as const;

export const inferenceEconomicTreatmentSchema = z.enum(INFERENCE_ECONOMIC_TREATMENTS);

export type InferenceEconomicTreatment = z.infer<typeof inferenceEconomicTreatmentSchema>;
