/**
 * Who is ASKING, as opposed to who is being acted AS.
 *
 * ## The two identities an operated session carries
 *
 * A session minted by `POST /accounts/:id/switch` authenticates as the managed
 * account — that is its SUBJECT, and it is what `requireUserId(req)` returns.
 * But its authority is not the account's; it is the authority of the HUMAN
 * recorded on the session as `operatedByUserId`. `#934` decided that and wrote
 * it down: *"An operated session authenticates as the managed account, but its
 * RBAC remains that of the human operator recorded on the server-side session."*
 *
 * Every RBAC question — may this caller create a child here, read this subtree,
 * invite this member, manage this application — is a question about the
 * OPERATOR. Every question about identity — whose account is this, where does a
 * new child hang by default — is a question about the SUBJECT. They are the same
 * value for a personal session and different the moment somebody switches, which
 * is exactly why the confusion survived so long: on a personal account the two
 * readings agree and the ambiguity is invisible.
 *
 * ## Why this module exists rather than a local helper
 *
 * It lived as a private function inside `routes/accounts.ts`, so it was the only
 * router that COULD ask. Everywhere else the subject was the only identity in
 * reach, and four route files ended up authorizing against it —
 * `POST /accounts` refusing an organization's own owner the right to create an
 * agent under it, and `POST /applications` refusing the same person the same way.
 * The fix for one of them is not a fix for the class while the answer is
 * reachable from one file.
 *
 * ## Why not middleware that sets a field on every request
 *
 * Deliberately a CALL, not an ambient `req.operatorId` populated for everything.
 * An ambient field is free to read and therefore free to read by mistake — the
 * failure this whole module exists to prevent is a route reaching for whichever
 * identity was nearest. A call appears in the diff and names which question is
 * being asked. Routes that resolve an account context still cache the result on
 * the request (`AccountContextRequest.operatorId`) so one request does not read
 * its session twice.
 */

import type { Request } from 'express';
import { extractTokenFromRequest, decodeToken } from './authUtils';
import sessionService from '../services/session.service';
import { UnauthorizedError } from '../utils/error';
import { logger } from '../utils/logger';

/**
 * The minimum a request must carry to be asked these questions: the
 * authenticated account, and the headers the bearer is read from.
 *
 * STRUCTURAL rather than the routers' `AuthRequest`, and deliberately so. Each
 * router declares its own `AuthRequest` — `profiles.ts` types `user` as
 * `{ id: string }` while `auth.ts` types it as a full `AccountDocument` — so a
 * module that named one of them would be importable by one router and a cast at
 * every other call site. A cast is exactly how the wrong identity gets passed.
 */
export type OperatorRequest = Request & { user?: { _id?: unknown } | null };

/**
 * The authenticated account id, or 401.
 *
 * Read here rather than imported: each router declares its own private copy of
 * this three-line check, so there is no shared one to import — and this module
 * must not depend on whichever router happens to be loaded.
 */
function authenticatedAccountId(req: OperatorRequest): string {
  const userId = req.user?._id?.toString();
  if (!userId) {
    throw new UnauthorizedError('Authentication required');
  }
  return userId;
}

/**
 * The OPERATOR behind this request — the human, never the account being
 * acted-as.
 *
 * For an ordinary session the operator IS the authenticated account. For an
 * operated (managed / sub-account) session the operator is the `operatedByUserId`
 * recorded on the server-side session, so every authorization stays anchored on
 * the person no matter which of their accounts is currently active.
 *
 * `operatedByUserId` is authoritative and server-set at switch time (bound to the
 * operator's `account:act_as` membership, and re-verified on validate/refresh by
 * `ensureManagedSessionAuthorized`), so trusting it here escalates nothing — it
 * is the same fact the switch already proved. The bearer JWT does not carry it
 * (session-doc-only), so it is read from the request-cached session record.
 *
 * A missing or unreadable session degrades to the authenticated account. That
 * direction is the safe one: it can only ever answer with LESS authority than
 * the operator has, because a managed account is never a member of itself and
 * `effectiveAccessForAccount` grants implicit ownership only to a `personal`
 * account acting as itself.
 */
export async function resolveOperatorId(req: OperatorRequest): Promise<string> {
  const authedUserId = authenticatedAccountId(req);
  const token = extractTokenFromRequest(req);
  const sessionId = token ? decodeToken(token)?.sessionId : undefined;
  if (!sessionId) {
    return authedUserId;
  }
  try {
    const sessionDoc = await sessionService.getSession(sessionId, true);
    const operator = sessionDoc?.operatedByUserId ? sessionDoc.operatedByUserId.toString() : null;
    return operator ?? authedUserId;
  } catch (error) {
    logger.debug('[operator] session lookup failed, using the authenticated account', {
      component: 'operator',
      method: 'resolveOperatorId',
      error: error instanceof Error ? error.message : String(error),
    });
    return authedUserId;
  }
}

/**
 * The SUBJECT of this request — the account the session speaks as.
 *
 * A thin, deliberately-named reading of `requireUserId`. It exists so a call site
 * has to SAY which identity it means: a bare `requireUserId(req)` reads like
 * "the user", which is the ambiguity that produced the bug. Use it where the question is
 * about identity rather than authority — most importantly, where a new child
 * account hangs when the caller named no parent.
 */
export function resolveSubjectId(req: OperatorRequest): string {
  return authenticatedAccountId(req);
}
