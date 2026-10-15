/**
 * The closed value sets `kaana_grants` stores are the ones the grant contract
 * (`@kaana.ai/contracts/internal`) speaks, member for member: a value the
 * contract adds would otherwise be a grant Oxy signs and cannot record.
 */
import {
  grantLaneSchema,
  grantOperationSchema,
  inferenceEconomicTreatmentSchema,
  inferenceFundingTierSchema,
} from '@kaana.ai/contracts/internal';
import { USAGE_UNITS as KAANA_USAGE_UNITS } from '@kaana.ai/contracts';
import { USAGE_UNITS } from '@oxy.so/contracts';
import {
  KAANA_FUNDING_TIERS,
  KAANA_GRANT_LANES,
  KAANA_GRANT_OPERATIONS,
  KAANA_GRANT_TREATMENTS,
} from '../kaanaGrants';

describe('kaana_grants value sets match @kaana.ai/contracts/internal', () => {
  it.each([
    ['operations', KAANA_GRANT_OPERATIONS, grantOperationSchema.options],
    ['lanes', KAANA_GRANT_LANES, grantLaneSchema.options],
    ['treatments', KAANA_GRANT_TREATMENTS, inferenceEconomicTreatmentSchema.options],
    ['funding tiers', KAANA_FUNDING_TIERS, inferenceFundingTierSchema.options],
    ['usage units (the ledger prices what Kaana reports)', USAGE_UNITS, KAANA_USAGE_UNITS],
  ])('%s', (_name, stored, contract) => {
    expect([...stored]).toEqual([...contract]);
  });
});
