/**
 * Which side of a deployment each migration belongs on.
 *
 * THE BUG THIS EXISTS FOR
 *
 * A migration added a column, and the same pull request added code that
 * selected that column by name. The image reached production; the column did
 * not. Every request that read the new column returned 500 ecosystem-wide
 * until the migration was dispatched by hand.
 *
 * The migration itself was additive, defaulted, dropped nothing and
 * documented its own ordering requirement. None of that helped, because the
 * ordering depended on a human performing two dispatches in the right order
 * while a deploy raced them.
 *
 * So a migration now DECLARES its side, in its own file, on one line:
 *
 *     -- oxy:deploy-phase=pre      applied BEFORE the new image rolls out
 *     -- oxy:deploy-phase=post     applied AFTER the new image is live
 *
 * `pre` is every additive change — a new column carrying a DEFAULT, a new
 * table, a widened CHECK. Correct against the image still serving AND the one
 * arriving, so it can be applied while the old image runs.
 *
 * `post` is every change that takes something away — a DROP, a RENAME, a
 * narrowed constraint. Applied early it is an outage on the image still
 * serving: drizzle selects columns by name, so dropping one 500s every read
 * the previous image performs. That is the second half of the same pull
 * request, and it is exactly why "always migrate first" is wrong as a blanket
 * rule.
 *
 * THERE IS NO DEFAULT, and that is the point. A migration with no marker, with
 * two, or with an unrecognised value is a hard failure both in a CI gate and
 * at migration time. A default would quietly pick a side for a migration
 * whose author never considered the question — the same class of failure as
 * the incident above, moved one step later and made harder to see.
 *
 * WHY THIS MODULE IMPORTS NOTHING BUT NODE BUILTINS
 *
 * A CI gate that checks every migration file for a marker typically has to
 * run before the rest of a project's dependencies are installed. Keeping this
 * module dependency-free is what lets such a gate import the REAL marker
 * reader instead of carrying a second copy of the regex — so the gate and the
 * migrator can never disagree about what a marker says.
 *
 * Nothing here throws. Problems are RETURNED, because the same list has to
 * become a CI failure message in one caller and a migration-time refusal in
 * another.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The side of a deployment a migration is safe to run on. */
export type DeployPhase = 'pre' | 'post';

/** Every accepted marker value, in the order the docs list them. */
export const DEPLOY_PHASES: readonly DeployPhase[] = ['pre', 'post'];

/** What a migration run is allowed to apply. */
export type MigrationRun = 'pre' | 'post' | 'all';

/**
 * Every accepted {@link MigrationRun} value. How a caller spells this on its
 * own command line is the caller's business — this package takes a `run`
 * option, not a flag.
 */
export const MIGRATION_RUNS: readonly MigrationRun[] = ['pre', 'post', 'all'];

/** The one accepted spelling of a phase marker. */
export function phaseMarkerLine(phase: DeployPhase): string {
  return `-- oxy:deploy-phase=${phase}`;
}

/**
 * The POSIX ERE a deploy workflow can grep the migration files with, to
 * decide whether a release needs a post-rollout migration task at all.
 * Exported so a workflow cannot drift from the marker syntax this module
 * accepts: a CI gate can assert the workflow contains this exact string.
 *
 * A grep is sound here ONLY because the gate separately proves every
 * migration carries exactly one well-formed marker line. Without that, a
 * typo'd marker would read as "no post migration in this release" and the
 * drop would never be applied by anything.
 */
export const POST_PHASE_GREP_PATTERN = '^-- oxy:deploy-phase=post$';

/**
 * A marker line with the value left unconstrained on purpose. Matching
 * `(pre|post)` instead would make `-- oxy:deploy-phase=later` indistinguishable
 * from a file with no marker at all, and "you wrote a phase I do not recognise"
 * is a far more useful thing to be told than "you wrote no phase".
 */
const MARKER_LINE = /^-- oxy:deploy-phase=(.*)$/;

/** What `readMigrationPhases` found, and everything it could not make sense of. */
export interface MigrationPhaseReadResult {
  /** Tag -> declared phase, for every migration that declared one legibly. */
  phases: Map<string, DeployPhase>;
  /** Human-readable problems. Empty means every tag is in `phases`. */
  problems: string[];
}

/**
 * Read the phase marker out of each migration file.
 *
 * @param tags Journal tags, in journal order. A tag with no `<tag>.sql` beside
 *   it is a problem rather than a silent omission — an image shipped without
 *   its migrations must never read as "nothing declared, nothing to do".
 * @param folder The `drizzle/` directory holding `<tag>.sql`.
 */
export function readMigrationPhases(
  tags: readonly string[],
  folder: string
): MigrationPhaseReadResult {
  const phases = new Map<string, DeployPhase>();
  const problems: string[] = [];

  for (const tag of tags) {
    const path = join(folder, `${tag}.sql`);

    let contents: string;
    try {
      contents = readFileSync(path, 'utf8');
    } catch (error) {
      problems.push(
        `${tag}: cannot read ${path} (${error instanceof Error ? error.message : String(error)}).`
      );
      continue;
    }

    const values: string[] = [];
    for (const line of contents.split('\n')) {
      const match = MARKER_LINE.exec(line.replace(/\r$/, ''));
      if (match) values.push(match[1]);
    }

    if (values.length === 0) {
      problems.push(
        `${tag}: no deploy-phase marker. Add exactly one line reading ` +
        `\`${phaseMarkerLine('pre')}\` (additive — safe while the previous image serves) or ` +
        `\`${phaseMarkerLine('post')}\` (drops/renames/narrows — only safe once the new image is live) ` +
        `to ${tag}.sql.`
      );
      continue;
    }

    if (values.length > 1) {
      problems.push(
        `${tag}: ${values.length} deploy-phase markers (${values.join(', ')}). \
Exactly one, or the file does not say which side of the deploy it belongs on.`
      );
      continue;
    }

    const value = values[0];
    if (!isDeployPhase(value)) {
      problems.push(
        `${tag}: unrecognised deploy phase "${value}". Use one of: ${DEPLOY_PHASES.join(', ')}.`
      );
      continue;
    }

    phases.set(tag, value);
  }

  return { phases, problems };
}

function isDeployPhase(value: string): value is DeployPhase {
  return (DEPLOY_PHASES as readonly string[]).includes(value);
}

/** What a run may apply, what it must leave alone, and why it may do neither. */
export interface MigrationRunPlan<T> {
  /** Migrations this run applies, in journal order. */
  apply: T[];
  /** Pending migrations this run deliberately leaves for a later phase. */
  deferred: T[];
  /**
   * Non-null when there is no ordering this run can take that is safe. The
   * caller must fail, and this string names the migrations responsible.
   */
  blocked: string | null;
}

/**
 * Decide what a run applies.
 *
 * `all` applies everything pending. This is a developer's database, a test
 * harness, and a manual escape hatch that dispatches every pending migration
 * at once — none of which has a previous image to protect.
 *
 * `pre` runs while the PREVIOUS image is still serving, so it applies the
 * longest run of `pre` migrations at the front of the pending list and stops at
 * the first `post` one.
 *
 * The stop has to be a PREFIX, because the ledger records progress as "the
 * newest `created_at` applied" (see `pendingEntries` in `./ledger`) — there is
 * no way to express a hole. So a `pre` migration sitting BEHIND an unapplied
 * `post` one cannot be applied without also applying the `post` one, and
 * applying that breaks the image currently serving. Neither half is
 * acceptable, so the run is BLOCKED and names both. It is the one case a human
 * must resolve, and it is loud rather than silent, which is the whole point.
 *
 * `post` runs once the new image is live and applies everything still pending.
 * It BLOCKS if a `pre` migration is pending, because at that point the pre
 * phase either never ran or did not do its job: the live image is already
 * reading a column that does not exist. Blocking fails the post-deploy task,
 * which rolls the service back to the image that matches the schema on disk —
 * the correct repair, and one that says out loud what went wrong.
 */
export function planMigrationRun<T extends { tag: string }>(
  pending: readonly T[],
  phases: ReadonlyMap<string, DeployPhase>,
  run: MigrationRun
): MigrationRunPlan<T> {
  const undeclared = pending.filter((entry) => !phases.has(entry.tag));
  if (undeclared.length > 0) {
    return {
      apply: [],
      deferred: [],
      blocked:
        `${undeclared.length} pending migration(s) do not declare a deploy phase: \
${undeclared.map((entry) => entry.tag).join(', ')}. \
Refusing to guess which side of a deploy they belong on.`,
    };
  }

  if (run === 'all') {
    return { apply: [...pending], deferred: [], blocked: null };
  }

  if (run === 'post') {
    const stranded = pending.filter((entry) => phases.get(entry.tag) === 'pre');
    if (stranded.length > 0) {
      return {
        apply: [],
        deferred: [],
        blocked:
          `${stranded.map((entry) => entry.tag).join(', ')} \
${stranded.length === 1 ? 'is a pre-deploy migration that is' : 'are pre-deploy migrations that are'} \
still pending after the rollout. The pre-deploy migration step did not apply \
it, so the image now serving is reading a schema this database does not have. \
Failing so the deployment rolls back to the image that matches.`,
      };
    }
    return { apply: [...pending], deferred: [], blocked: null };
  }

  const firstPost = pending.findIndex((entry) => phases.get(entry.tag) === 'post');
  if (firstPost === -1) {
    return { apply: [...pending], deferred: [], blocked: null };
  }

  const deferred = pending.slice(firstPost);
  const stranded = deferred.find((entry) => phases.get(entry.tag) === 'pre');
  if (stranded) {
    return {
      apply: [],
      deferred: [],
      blocked:
        `${stranded.tag} is a pre-deploy migration queued behind the post-deploy migration \
${pending[firstPost].tag}, which is not applied yet. Applying ${stranded.tag} would \
require applying ${pending[firstPost].tag} first — the ledger records progress as a \
high-water mark and cannot skip one — and that would break the image currently \
serving. Leaving ${stranded.tag} unapplied would break the image about to serve. \
Deploy them in separate releases, or run this migration with \`all\` and accept that \
the image currently serving 500s until this rollout completes.`,
    };
  }

  return { apply: pending.slice(0, firstPost), deferred, blocked: null };
}
