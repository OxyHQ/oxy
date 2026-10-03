/** Live authority and product audience. Access is independent of billing read. */
import { getDb } from '../config/postgres';
import { accountClosureFences, applicationCredentials } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { subjectProductAccessQuerySchema, type SubjectProductAccessQuery } from '@oxy.so/contracts';
import type { AccessTokenIdentity } from '../utils/sessionUtils';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/error';
import { isCredentialUsable } from '../utils/credentialUsability';
import sessionService from './session.service';
import { resolveCallerAccountAccess } from './attribution.service';
import { readRegisteredProduct, readSubjectProductAccess } from './productAccessPersistence.service';

export async function readAuthorizedSubjectProductAccess(identity: AccessTokenIdentity, input: SubjectProductAccessQuery) {
  const query = subjectProductAccessQuerySchema.parse(input);
  if (query.subjectAccountId !== identity.subjectAccountId) throw new NotFoundError('Product access is unavailable');
  // Force the shared session/managed-account authority reader, bypassing caches.
  const current = await sessionService.validateSessionById(identity.sessionId, false, { useCache: false });
  if (!current || current.session.userId !== identity.subjectAccountId
    || (current.session.operatedByUserId ?? current.session.userId) !== identity.principalUserId
    || current.session.applicationId !== identity.applicationId || current.session.clientId !== identity.clientId) {
    throw new UnauthorizedError('Current session authority is unavailable');
  }
  if (!identity.applicationId || !identity.scopes.includes('user:read') || !current.session.scopes.includes('user:read')) {
    throw new ForbiddenError('An application-bound user:read session is required');
  }
  const [credential] = await getDb().select().from(applicationCredentials).where(and(
    eq(applicationCredentials.publicKey, identity.clientId ?? ''), eq(applicationCredentials.applicationId, identity.applicationId)));
  if (!credential || !isCredentialUsable(credential) || credential.environment !== 'production') {
    throw new ForbiddenError('A production application credential is required');
  }
  const access = await resolveCallerAccountAccess(identity.principalUserId, query.subjectAccountId, current.session.sessionId);
  if (access.status !== 'resolved') throw new NotFoundError('Product access is unavailable');
  if (!access.access.accountPermissions.includes('account:read')) throw new ForbiddenError('This action requires account:read');
  const [fence] = await getDb().select().from(accountClosureFences).where(eq(accountClosureFences.accountId, query.subjectAccountId));
  if (fence) throw new NotFoundError('Product access is unavailable');
  const product = await readRegisteredProduct(getDb(), query.productId);
  if (product.applicationId !== identity.applicationId) throw new NotFoundError('Product access is unavailable');
  return readSubjectProductAccess(query.subjectAccountId, query.productId);
}
