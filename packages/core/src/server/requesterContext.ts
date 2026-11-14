import type { ServiceLane } from '../client/context';

/** One original requester proof, kept transient and isolated per operation. */
export type RequesterProof = (
  | { requesterToken: string; taskId?: never; capabilityTicket?: never; requesterContext?: never }
  | { taskId: string; requesterToken?: never; capabilityTicket?: never; requesterContext?: never }
  | { capabilityTicket: string; requesterToken?: never; taskId?: never; requesterContext?: never }
  | { requesterContext: string; requesterToken?: never; taskId?: never; capabilityTicket?: never }
) & { accountId?: string };

export function bindRequesterLane(original: ServiceLane, proof: RequesterProof): ServiceLane {
  const values = [
    proof.requesterToken,
    proof.taskId,
    proof.capabilityTicket,
    proof.requesterContext,
  ].filter((value) => value !== undefined);
  if (
    values.length !== 1 ||
    !values[0] ||
    values[0].length > 16384 ||
    /\s/.test(values[0]) ||
    (proof.accountId !== undefined && (!proof.accountId || /\s/.test(proof.accountId)))
  )
    throw new Error('One requester proof and an optional exact account ID are required');
  const fixed = {
    requesterToken: proof.requesterToken,
    taskId: proof.taskId,
    capabilityTicket: proof.capabilityTicket,
    requesterContext: proof.requesterContext,
    actAs: proof.accountId,
    requesterAccountId: undefined,
  };
  return bindLane(original, fixed);
}

/**
 * The account an Oxy service acts for (ADR 0066), and the person when they
 * operate that account. No proof: the service acts with the authority its
 * first-party registry entry declares, and Oxy checks the accounts live.
 */
export interface ActingFor {
  accountId: string;
  requesterAccountId?: string;
}

function exactAccountId(value: string | undefined): boolean {
  return value === undefined || (value.length > 0 && value.length <= 128 && !/\s/.test(value));
}

export function bindActingForLane(original: ServiceLane, actingFor: ActingFor): ServiceLane {
  if (
    !actingFor.accountId ||
    !exactAccountId(actingFor.accountId) ||
    !exactAccountId(actingFor.requesterAccountId)
  )
    throw new Error('An exact account id is required');
  return bindLane(original, {
    actAs: actingFor.accountId,
    requesterAccountId: actingFor.requesterAccountId,
  });
}

type LaneAuthority = NonNullable<Parameters<ServiceLane['request']>[3]>;

/** One lane whose authority headers are fixed and never taken from a caller. */
function bindLane(
  original: ServiceLane,
  fixed: Pick<
    LaneAuthority,
    | 'actAs'
    | 'requesterAccountId'
    | 'requesterToken'
    | 'taskId'
    | 'capabilityTicket'
    | 'requesterContext'
  >,
): ServiceLane {
  return {
    get available() {
      return original.available;
    },
    request: (method, url, data, options) => {
      const headers = { ...options?.headers };
      for (const key of Object.keys(headers))
        if (
          [
            'x-oxy-user-id',
            'x-oxy-requester-id',
            'x-oxy-task-id',
            'x-oxy-requester-token',
            'x-oxy-capability-ticket',
            'x-oxy-requester-context',
            'x-oxy-presented-requester-context',
            'x-oxy-presented-service-token',
            'x-oxy-mcp-media-token',
            'x-oxy-mcp-media-tool',
          ].includes(key.toLowerCase())
        )
          delete headers[key];
      return original.request(method, url, data, {
        ...options,
        ...fixed,
        headers,
        cache: false,
        deduplicate: false,
        retry: false,
      });
    },
  };
}
