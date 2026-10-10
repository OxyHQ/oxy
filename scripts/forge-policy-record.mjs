/** Closed policy data and timing only. This does not authenticate a human. */
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) =>
  object(x) && Object.keys(x).sort().join('|') === [...keys].sort().join('|');
const commit = (x) => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const hash = (x) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const iso = (x) =>
  typeof x === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) &&
  Number.isFinite(Date.parse(x));
export function checkScopedPolicyRecord(decision, now, source = undefined) {
  const errors = [];
  if (
    !exact(decision, [
      'schemaVersion',
      'status',
      'targetSourceHead',
      'expiresAt',
      'authorizationRecord',
      'independentEvidence',
    ]) ||
    decision.schemaVersion !== 1 ||
    !['INACTIVE', 'ACTIVE'].includes(decision.status)
  )
    return { valid: false, errors: ['Invalid closed policy JSON'] };
  if (decision.status === 'INACTIVE') {
    if (
      ['targetSourceHead', 'expiresAt', 'authorizationRecord', 'independentEvidence'].some(
        (key) => decision[key] !== null,
      )
    )
      errors.push('Inactive policy must contain no decision or evidence claim');
    return { valid: errors.length === 0, status: decision.status, errors, authorized: false };
  }
  if (
    !commit(decision.targetSourceHead) ||
    (source !== undefined && decision.targetSourceHead !== source)
  )
    errors.push('Policy target differs from frozen source');
  const record = decision.authorizationRecord;
  if (
    !exact(record, ['channel', 'reference', 'instructionSha256', 'recordedAt']) ||
    record.channel !== 'explicit-user-session' ||
    typeof record.reference !== 'string' ||
    record.reference.trim().length < 10 ||
    !hash(record.instructionSha256) ||
    !iso(record.recordedAt)
  )
    errors.push('Missing separate explicit session record');
  const evidence = decision.independentEvidence;
  if (
    !exact(evidence, ['sourceHead', 'proofSha256']) ||
    !commit(evidence.sourceHead) ||
    !hash(evidence.proofSha256)
  )
    errors.push('Missing closed independent evidence record');
  if (
    !iso(now) ||
    !iso(decision.expiresAt) ||
    !iso(record?.recordedAt) ||
    Date.parse(record.recordedAt) > Date.parse(now) ||
    Date.parse(decision.expiresAt) <= Date.parse(now) ||
    Date.parse(decision.expiresAt) > Date.parse(record.recordedAt) + 7 * 86400000
  )
    errors.push('Policy is invalid, expired or exceeds seven days');
  return { valid: errors.length === 0, status: decision.status, errors, authorized: false };
}
