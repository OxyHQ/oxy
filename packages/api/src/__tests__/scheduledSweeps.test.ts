/**
 * Both sweepers are REACHABLE — the entrypoint schedules them (issue #1015).
 *
 * ## Why an assertion on the entrypoint, and not on the sweepers
 *
 * `expireReservations` and `sweepAllExpiredRows` were both implemented, both
 * tested, and both called by nothing outside `__tests__`. Every one of those
 * tests passed, and would have kept passing forever, because a test that
 * invokes a sweeper directly proves the sweeper works and says nothing at all
 * about whether it ever runs. That gap is the entire bug: the mechanism is
 * green and inert, and inert has no symptom until a customer's balance is
 * wrong or a ninety-day retention turns out to be permanent.
 *
 * So the subject here is `server.ts` itself. It is read as source rather than
 * imported and executed: importing it opens a Postgres pool, seeds policy
 * rows, mounts every route and starts an HTTP listener, none of which this
 * assertion is about — and a `bootstrap()` that hung or refused would take the
 * assertion down with it, turning "the sweep is not registered" and "the boot
 * path is unwell" into the same red.
 *
 * ## The vacuity floor
 *
 * A source read is exactly the shape that reports a clean, confident absence
 * when it is looking at the wrong file, an empty file, or a file that moved.
 * `expect(SOURCE).toContain(x)` failing then means "the path is wrong", but it
 * reads as "the registration is gone" — and, far worse, `not.toContain` would
 * PASS. Three floors, before any real assertion:
 *
 *  - the read returned a substantial file, not '' from a missing path;
 *  - it is the entrypoint (it declares `bootstrap`), not some other server;
 *  - it can see the sweeps that were already there. That last one is the
 *    positive control in the same currency as the measurement: if this read
 *    cannot find `followExpirySweep`, it cannot find anything, and the
 *    assertions below are measuring nothing.
 *
 * And a source read has one more failure mode a floor cannot cover: a COMMENT
 * quoting the call satisfies it. The registrations are heavily commented and
 * those comments name what they schedule, so every assertion about a call is
 * made against `SERVER_CODE` — the source with comments stripped — which is
 * what makes "delete the scheduling, keep the comment" go red. The stripper
 * carries controls in both directions, since a stripper that ate the file and
 * one that stripped nothing both look like success from one side.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXPIRY_SWEEP_INTERVAL_MS, EXPIRY_SWEEP_TARGETS } from '../db/expiry';
import { RESERVATION_EXPIRY_SWEEP_INTERVAL_MS } from '../db/schema/usageReservations';
import {
  RECONCILIATION_LEASE_MS,
  RECONCILIATION_PERIOD_MS,
  RECONCILIATION_SWEEP_INTERVAL_MS,
} from '../db/schema/billingReconciliation';
import {
  BASELINE_WINDOW_DAYS,
  MINIMUM_BASELINE_DAYS,
  SPEND_ANOMALY_SWEEP_INTERVAL_MS,
} from '../services/spendAnomaly.service';
import {
  MINIMUM_TOKEN_BASELINE_DAYS,
  TOKEN_ANOMALY_SWEEP_INTERVAL_MS,
  TOKEN_BASELINE_WINDOW_DAYS,
} from '../services/tokenAnomaly.service';

const SERVER_PATH = join(__dirname, '..', 'server.ts');
const SERVER_SOURCE = readFileSync(SERVER_PATH, 'utf8');

/**
 * `server.ts` with its comments removed.
 *
 * Every assertion about a CALL is made against this, not the raw source. The
 * registrations below are heavily commented and those comments name the
 * functions they schedule; a search over raw source would therefore be
 * satisfied by prose describing the call, so deleting the scheduling and
 * leaving the comment — the single most likely way this regresses — would read
 * as green. That is the same trap as a census that counts a commented-out line.
 */
const SERVER_CODE = SERVER_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

describe('the entrypoint this suite reads', () => {
  it('is the real one, and this read can see what is already in it', () => {
    // Not '' from a missing path, and not a stub.
    expect(SERVER_SOURCE.length).toBeGreaterThan(10_000);
    // The entrypoint, not another file that happens to be called server.
    expect(SERVER_SOURCE).toContain('export async function bootstrap(');
    // The positive control: sweeps that predate this issue and are known to be
    // registered. A read that cannot find these has found nothing, and every
    // assertion below would be reporting on its own blindness.
    expect(SERVER_CODE).toContain('followExpirySweep.unref()');
    expect(SERVER_CODE).toContain('autoRechargeSweep.unref()');
  });

  it('has comments stripped, and still has its code', () => {
    // The stripper's own controls, in both directions. Without the first,
    // "comments are gone" is also what a stripper that ate the whole file
    // reports; without the second, one that stripped nothing looks identical to
    // one that worked.
    //
    // "Code survived" is asserted DIRECTLY — an absolute floor plus a line of
    // real code — and not as a fraction of the source. A `> SOURCE.length / 2`
    // floor was the original form and it erodes as the registrations get better
    // commented: it went red on a well-documented sweep whose code was entirely
    // intact, which is a floor measuring comment density rather than the
    // stripper.
    expect(SERVER_CODE.length).toBeGreaterThan(10_000);
    expect(SERVER_CODE).toContain('export async function bootstrap(');
    expect(SERVER_SOURCE).toContain('// Release holds whose deadline has passed');
    expect(SERVER_CODE).not.toContain('// Release holds whose deadline has passed');
  });

  it('strips BLOCK comments too, not only line comments', () => {
    // The stripper has two independent stages — a `/* … */` replace and a `//`
    // line filter — and the control above only exercises the second. Measured: a
    // mutation that broke the block stage alone left all thirteen tests green,
    // because every registration comment in `server.ts` happens to be a line
    // comment. A `/* … */` block quoting `runScheduledReconciliation()` would
    // then satisfy the searches below, which is the exact thing the stripping is
    // for. So the block stage gets its own control, in the same shape.
    const jsdocLine =
      '* True only for the service-token media stream-upload requests. Uses `req.path`';
    expect(SERVER_SOURCE).toContain(jsdocLine);
    expect(SERVER_CODE).not.toContain(jsdocLine);
  });
});

describe('the reservation expiry sweep is registered', () => {
  it('schedules expireReservations on its own interval', () => {
    expect(SERVER_CODE).toContain("import { expireReservations } from './services/inferenceLedger.service'");
    expect(SERVER_CODE).toContain('expireReservations()');
    expect(SERVER_CODE).toContain('RESERVATION_EXPIRY_SWEEP_INTERVAL_MS');
    // Unref'd, like every other sweep: an interval that keeps the event loop
    // alive hangs jest non-deterministically and blocks a graceful shutdown.
    expect(SERVER_CODE).toContain('reservationExpirySweep.unref()');
  });

  it('releases a hold well inside the shortest deadline an edge would set', () => {
    // The interval is how long money stays withheld PAST the deadline it was
    // promised back at. A reservation's own `expiresInSeconds` is set per
    // request and is measured in minutes, so a sweep that ran on the same order
    // as the deadline would roughly double the time a customer's balance is
    // depressed for a request that already died.
    expect(RESERVATION_EXPIRY_SWEEP_INTERVAL_MS).toBeLessThanOrEqual(60 * 1000);
    expect(RESERVATION_EXPIRY_SWEEP_INTERVAL_MS).toBeGreaterThan(0);
  });
});

describe('the retention sweep is registered', () => {
  it('sweeps every declared retention on its own interval', () => {
    expect(SERVER_CODE).toContain("import { sweepAllExpiredRows } from '@oxyhq/db/expiry'");
    // The registry, not a hand-listed subset — a sweep over some other list
    // would leave the rest of `db/expiry.ts` declaring retentions nobody
    // enforces, which is the state this issue found.
    expect(SERVER_CODE).toContain('sweepAllExpiredRows(getDb(), EXPIRY_SWEEP_TARGETS)');
    expect(SERVER_CODE).toContain('EXPIRY_SWEEP_INTERVAL_MS');
    expect(SERVER_CODE).toContain('retentionSweep.unref()');
  });

  it('runs often enough for the shortest retention it enforces', () => {
    // Zero-second entries are the ones the interval actually decides: their row
    // is deletable the instant `expiresAt` passes, so the interval IS the lag.
    // Every such entry is documented as housekeeping — nothing reads a swept
    // table without its own expiry filter — so an hour is a storage decision,
    // not a correctness one. This asserts the direction anyway: a retention
    // sweep running less often than daily would let the shortest windows drift
    // far enough that "ninety days" and "whenever the sweep last ran" stop
    // being the same claim.
    expect(EXPIRY_SWEEP_INTERVAL_MS).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    expect(EXPIRY_SWEEP_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('has something to sweep', () => {
    // A floor on the registry itself: `sweepAllExpiredRows` over an empty list
    // is a scheduled no-op, and would satisfy every assertion above.
    expect(EXPIRY_SWEEP_TARGETS.length).toBeGreaterThan(10);
  });
});

describe('the reconciliation sweep is registered', () => {
  it('schedules runScheduledReconciliation on its own interval', () => {
    // Without this registration reconciliation drift has no series behind it:
    // every pass would be one a staff member remembered to start, which is the
    // exact "green and inert" shape this file exists for.
    expect(SERVER_CODE).toContain("from './services/billingReconciliation.service'");
    expect(SERVER_CODE).toContain('runScheduledReconciliation()');
    expect(SERVER_CODE).toContain('RECONCILIATION_SWEEP_INTERVAL_MS');
    expect(SERVER_CODE).toContain('reconciliationSweep.unref()');
  });

  it('ticks more often than the window it reconciles', () => {
    // Equal or longer and a restart across a period boundary loses that window
    // for a whole further period. The claim makes the extra ticks free.
    expect(RECONCILIATION_SWEEP_INTERVAL_MS).toBeLessThan(RECONCILIATION_PERIOD_MS);
    expect(RECONCILIATION_SWEEP_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('believes a running pass for longer than a pass can take', () => {
    // The lease reclaims a window from a task that died. Shorter than a real
    // pass and it would reclaim a LIVE one, producing exactly the duplicate work
    // the claim exists to prevent — so it errs long.
    expect(RECONCILIATION_LEASE_MS).toBeGreaterThanOrEqual(RECONCILIATION_SWEEP_INTERVAL_MS);
  });

  // The window arithmetic itself, and the claim that makes N tasks safe, are
  // covered against a real Postgres in
  // `services/__tests__/billingReconciliation.service.test.ts` — importing the
  // service here would drag the Stripe adapter's graph into a file whose subject
  // is one `setInterval`.
});

describe('the spend-anomaly sweep is registered', () => {
  /*
   * Added by the change that registered it in `bootstrap()` but not here, which is
   * the exact shape of this file's opening paragraph: a detector that is
   * implemented, tested, and called by nothing outside `__tests__` has no symptom
   * until the spend spike it was built for goes unnoticed. It is a LAUNCH GATE in
   * #972 section 12, so inert is worse here than for most sweeps.
   */
  it('schedules sweepSpendAnomalies on its own interval', () => {
    expect(SERVER_CODE).toContain("from './services/spendAnomaly.service'");
    expect(SERVER_CODE).toContain('sweepSpendAnomalies()');
    expect(SERVER_CODE).toContain('SPEND_ANOMALY_SWEEP_INTERVAL_MS');
    expect(SERVER_CODE).toContain('spendAnomalySweep.unref()');
  });

  it('runs often enough to notice inside the hour it evaluates', () => {
    // The detector buckets spend by HOUR, so a sweep slower than an hour would let
    // a spike's own bucket close before anything looked at it. Both bounds: the
    // upper one is the claim, and `> 0` rules out a disabled interval satisfying it.
    expect(SPEND_ANOMALY_SWEEP_INTERVAL_MS).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(SPEND_ANOMALY_SWEEP_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('has a baseline long enough for the median it takes', () => {
    // A floor on the detector's own inputs, in the spirit of "has something to
    // sweep": a baseline window shorter than the minimum it demands would make
    // every account permanently unevaluated, and the sweep would run forever
    // finding nothing while looking exactly like a quiet platform.
    expect(BASELINE_WINDOW_DAYS).toBeGreaterThanOrEqual(MINIMUM_BASELINE_DAYS);
    expect(MINIMUM_BASELINE_DAYS).toBeGreaterThan(0);
  });
});

describe('the token-anomaly sweep is registered', () => {
  /*
   * The token half of "spend/token spikes". Registered beside the spend sweep and
   * gated here for the same reason that one is: a detector implemented, tested and
   * called by nothing has no symptom until the spike it was built for goes
   * unnoticed, and this one is a launch gate in §12.
   */
  it('schedules sweepTokenAnomalies on its own interval', () => {
    expect(SERVER_CODE).toContain("from './services/tokenAnomaly.service'");
    expect(SERVER_CODE).toContain('sweepTokenAnomalies()');
    expect(SERVER_CODE).toContain('TOKEN_ANOMALY_SWEEP_INTERVAL_MS');
    expect(SERVER_CODE).toContain('tokenAnomalySweep.unref()');
  });

  it('is a SEPARATE registration from the spend sweep, not a rename of it', () => {
    // Both must be scheduled. A change that replaced one with the other would
    // satisfy either assertion alone while silently dropping half the signal, and
    // the two measure different things over different tables.
    expect(SERVER_CODE).toContain('spendAnomalySweep.unref()');
    expect(SERVER_CODE).toContain('tokenAnomalySweep.unref()');
    expect(SERVER_CODE).toContain('sweepSpendAnomalies()');
    expect(SERVER_CODE).toContain('sweepTokenAnomalies()');
  });

  it('runs often enough to notice inside the hour it evaluates', () => {
    // The detector buckets by HOUR, so a sweep slower than an hour would let a
    // spike's own bucket close before anything looked at it. `> 0` rules out a
    // disabled interval satisfying the upper bound.
    expect(TOKEN_ANOMALY_SWEEP_INTERVAL_MS).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(TOKEN_ANOMALY_SWEEP_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('has a baseline long enough for the median it takes', () => {
    // A window shorter than the minimum it demands would leave every account
    // permanently unevaluated, and the sweep would run forever finding nothing
    // while looking exactly like a quiet platform.
    expect(TOKEN_BASELINE_WINDOW_DAYS).toBeGreaterThanOrEqual(MINIMUM_TOKEN_BASELINE_DAYS);
    expect(MINIMUM_TOKEN_BASELINE_DAYS).toBeGreaterThan(0);
  });
});
