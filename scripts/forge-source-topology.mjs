/** Structural source binding. Authentication comes only from the live collector. */
export const FROZEN_BASE_HEAD = 'eab1b6dd42b518500b49c03e692738081099d9cc';
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export function checkSourceTopologyStructure(git, pins, frozenBaseHead) {
  const errors = [];
  if (!sha(git?.head) || !sha(pins?.sourceSha) || git.clean !== true)
    errors.push('Clean checkout and immutable source required');
  if (!Array.isArray(git?.changedPaths)) errors.push('Complete source-to-checkout diff required');
  const execution = git?.currentGithub?.run;
  if (execution) {
    const prMerge =
      execution.event === 'pull_request' &&
      git?.headParents?.length === 2 &&
      git.headParents[1] === execution.head_sha;
    if (
      execution.repository?.id !== 973881060 ||
      execution.repository?.full_name !== 'OxyHQ/oxy' ||
      execution.head_repository?.full_name !== 'OxyHQ/oxy' ||
      (execution.head_sha !== git?.head && !prMerge)
    )
      errors.push('Authenticated execution must bind the actual checkout, never an older run');
  }
  if (git?.sourceIsAncestor === true)
    return { eligible: errors.length === 0, kind: 'descendant', errors };
  const allowed = [
    'docs/security/forge-candidate/provenance/pins.json',
    'docs/security/forge-candidate/provenance/audit-policy-decision.json',
  ];
  if (git?.changedPaths?.some((path) => !allowed.includes(path)))
    errors.push('Squash tree differs outside the exact two declarative paths');
  const context = git?.currentGithub;
  const run = context?.queueRun ?? context?.run;
  const commit = context?.commit;
  if (
    !run ||
    run.repository?.id !== 973881060 ||
    run.repository?.full_name !== 'OxyHQ/oxy' ||
    run.head_repository?.full_name !== 'OxyHQ/oxy' ||
    run.event !== 'merge_group' ||
    run.head_sha !== git?.head ||
    !/^gh-readonly-queue\/main\/pr-\d+-[a-f0-9]{40}$/.test(run.head_branch ?? '') ||
    !run.head_branch.endsWith(`-${frozenBaseHead}`)
  )
    errors.push(
      'Evidence source is not an ancestor: authenticated same-repository merge_group run and frozen base required',
    );
  if (
    commit?.sha !== git?.head ||
    commit?.parents?.length !== 1 ||
    commit.parents[0] !== frozenBaseHead ||
    git?.headParents?.length !== 1 ||
    git.headParents[0] !== frozenBaseHead ||
    commit?.tree !== git?.headTree ||
    !sha(commit?.tree)
  )
    errors.push('Authenticated squash commit must match local tree and exactly the frozen base');
  return { eligible: errors.length === 0, kind: 'squash', errors };
}

/** Runtime callers cannot select a different base. */
export function checkFrozenSourceTopology(git, pins) {
  return checkSourceTopologyStructure(git, pins, FROZEN_BASE_HEAD);
}
