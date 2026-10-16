/**
 * An application's own agents, and where they open (ADR 0044).
 *
 * The ONLY writer of `application_agents`. Its one caller is the staff lane of
 * the application administration router (`routes/applications.ts`), the same
 * lane that governs an application's scopes and capabilities; nothing an agent
 * owner, a person or an app can reach calls the write functions.
 *
 * The answer Alia reads is {@link agentAvailability}: an agent with no row, or
 * with `anywhere`, is available anywhere; one with `own_application` is
 * reachable only from requests whose verified app assertion (ADR 0045) names
 * that application.
 */

import { and, asc, eq } from 'drizzle-orm';
import type {
  AgentAvailability,
  ApplicationAgent,
  ApplicationAgentAvailability,
} from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { applicationAgents, type ApplicationAgentRow } from '../db/schema/applicationAgents';
import { userAncestors } from '../db/schema/userAncestors';
import { users } from '../db/schema/users';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/error';
import accountService from './account.service';

/** The application a row is written for, as the administration router loaded it. */
export interface ApplicationAgentOwner {
  id: string;
  ownerAccountId: string;
}

export function applicationAgentContract(row: ApplicationAgentRow): ApplicationAgent {
  return {
    applicationId: row.applicationId,
    agentAccountId: row.agentAccountId,
    availability: row.availability,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Whether the application's owner account operates `accountId`: it is the
 * owner, it is in the owner's subtree (an organization owns the projects under
 * it), or the owner holds `account:act_as` over it (a person who administers
 * the organization a bot sits under).
 */
async function ownerOperates(ownerAccountId: string, accountId: string): Promise<boolean> {
  if (accountId === ownerAccountId) return true;
  const [descendant] = await getDb()
    .select({ userId: userAncestors.userId })
    .from(userAncestors)
    .where(and(eq(userAncestors.userId, accountId), eq(userAncestors.ancestorId, ownerAccountId)))
    .limit(1);
  if (descendant) return true;
  return (await accountService.verifyActingAs(ownerAccountId, accountId)) !== null;
}

/**
 * Make `agentAccountId` one of the application's agents with this
 * availability, or change its availability.
 *
 * Refused unless the account is an active `bot` whose parent the application's
 * owner operates, and refused when the agent is already another application's:
 * an agent is one application's.
 */
export async function writeApplicationAgent(input: {
  application: ApplicationAgentOwner;
  agentAccountId: string;
  availability: ApplicationAgentAvailability;
  staffUserId: string;
}): Promise<ApplicationAgent> {
  const [agent] = await getDb()
    .select({
      kind: users.kind,
      accountStatus: users.accountStatus,
      parentAccountId: users.parentAccountId,
    })
    .from(users)
    .where(eq(users.id, input.agentAccountId))
    .limit(1);
  if (!agent || agent.kind !== 'bot' || agent.accountStatus !== 'active') {
    throw new BadRequestError('The agent must be an active bot account', {
      reason: 'agent_must_be_active_bot_account',
    });
  }
  if (
    !agent.parentAccountId ||
    !(await ownerOperates(input.application.ownerAccountId, agent.parentAccountId))
  ) {
    throw new BadRequestError(
      "The agent's parent account must be one the application's owner operates",
      { reason: 'agent_not_under_application_owner' },
    );
  }

  const [row] = await getDb()
    .insert(applicationAgents)
    .values({
      agentAccountId: input.agentAccountId,
      applicationId: input.application.id,
      availability: input.availability,
      createdByUserId: input.staffUserId,
    })
    .onConflictDoUpdate({
      target: applicationAgents.agentAccountId,
      set: { availability: input.availability, updatedAt: new Date() },
      // Only this application's own row is changed; another application's row
      // leaves nothing returned, which is the conflict below.
      setWhere: eq(applicationAgents.applicationId, input.application.id),
    })
    .returning();
  if (!row) {
    throw new ConflictError("The agent is already another application's agent", {
      reason: 'agent_belongs_to_another_application',
    });
  }
  return applicationAgentContract(row);
}

/** Stop `agentAccountId` being one of the application's agents. */
export async function removeApplicationAgent(
  applicationId: string,
  agentAccountId: string,
): Promise<void> {
  const removed = await getDb()
    .delete(applicationAgents)
    .where(
      and(
        eq(applicationAgents.applicationId, applicationId),
        eq(applicationAgents.agentAccountId, agentAccountId),
      ),
    )
    .returning({ agentAccountId: applicationAgents.agentAccountId });
  if (removed.length === 0) {
    throw new NotFoundError("The agent is not one of this application's agents");
  }
}

export async function listApplicationAgents(applicationId: string): Promise<ApplicationAgent[]> {
  const rows = await getDb()
    .select()
    .from(applicationAgents)
    .where(eq(applicationAgents.applicationId, applicationId))
    .orderBy(asc(applicationAgents.createdAt));
  return rows.map(applicationAgentContract);
}

/** Where an agent opens. An agent with no row is available anywhere. */
export async function agentAvailability(agentAccountId: string): Promise<AgentAvailability> {
  const [row] = await getDb()
    .select({
      applicationId: applicationAgents.applicationId,
      availability: applicationAgents.availability,
    })
    .from(applicationAgents)
    .where(eq(applicationAgents.agentAccountId, agentAccountId))
    .limit(1);
  if (!row || row.availability === 'anywhere') return { anywhere: true };
  return { anywhere: false, applicationIds: [row.applicationId] };
}
