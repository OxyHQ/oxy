import type { ContentClaimDetailView } from '@oxy.so/contracts';
import { useState } from 'react';
import { View } from 'react-native';

import { canBlock, isBlockableTarget } from '@/lib/content-claims';
import { ClaimActions } from './ClaimActions';
import { ClaimAudit } from './ClaimAudit';
import { ClaimOverview } from './ClaimOverview';
import { ClaimTargets } from './ClaimTargets';

/**
 * One content claim (ADR 0043 D10): the actions its state allows, the claimant's
 * statement, what it names, and the audit trail. Every action answers with the claim as
 * it now stands, which the hooks write straight into the detail cache.
 */
export function ClaimDetail({ claim }: { claim: ContentClaimDetailView }) {
  const [selected, setSelected] = useState<Array<string>>([]);
  const offerBlock = canBlock(claim.state) && claim.targets.some(isBlockableTarget);

  return (
    <View className="gap-6">
      <ClaimActions
        claim={claim}
        selected={selected}
        offerBlock={offerBlock}
        onBlocked={() => setSelected([])}
      />
      <ClaimOverview claim={claim} />
      <ClaimTargets
        claim={claim}
        selectable={offerBlock}
        selected={selected}
        onSelectionChange={setSelected}
      />
      <ClaimAudit events={claim.events} />
    </View>
  );
}
