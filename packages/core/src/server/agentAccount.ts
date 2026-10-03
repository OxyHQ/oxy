/** Autonomous entry helper. The signer owns its private key (for example in a KMS). */
import { buildAgentProofMessage, type LoginResult } from '@oxy.so/contracts';
import type { OxyServices } from '../OxyServices';

export interface AgentAccountSigner {
  /** Canonical compressed secp256k1 public key; no private-key field exists. */
  publicKey: string;
  signMessage(message: string): Promise<string>;
}

/** Explicit sign-in; no timer, automatic escalation or service credential lane. */
export async function signInAgentAccount(options: {
  client: Pick<OxyServices, 'auth'>;
  accountId: string;
  signer: AgentAccountSigner;
}): Promise<LoginResult> {
  const { client, accountId, signer } = options;
  const publicKey = signer.publicKey.trim().toLowerCase();
  const claims = await client.auth.agent.requestChallenge(publicKey);
  const timestamp = Date.now();
  if (claims.action !== 'agent_signin' || claims.accountId !== accountId || claims.actorId !== accountId
    || claims.publicKey !== publicKey || !claims.authMethodId || claims.expiresAt <= timestamp) {
    throw new Error('Agent challenge does not match this account and signer');
  }
  const signature = await signer.signMessage(buildAgentProofMessage(claims, timestamp));
  return client.auth.agent.verify(publicKey, { challenge: claims.challenge, timestamp, signature });
}
