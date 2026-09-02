/**
 * One explicit routing scorecard per exact Kaana deployment identity.
 *
 * Every dimension carries its own provenance. Price is bound to the exact Oxy
 * price version it evaluated; latency and throughput carry bounded measurement
 * windows and expiry; balanced carries the reviewed formula and expiry. A
 * scorecard can therefore become unavailable, but it cannot remain apparently
 * valid after the evidence it describes changes or expires.
 *
 * Draft, restricted or retired `inference_deployments` rows may reuse one Kaana
 * route while staff prepare audience-specific offers. Approved rows may not: a
 * partial unique index makes one Kaana identity globally publishable only once
 * until a viewer-aware commercial selection contract exists. Runtime and
 * readiness retain fail-closed collision checks as defence in depth. There is
 * deliberately no FK to the otherwise non-unique
 * `inference_deployments.internal_route_id`; the admin writer proves the mapping
 * and the cutover gate proves complete selectable coverage.
 */

import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';
import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { priceVersions } from './priceVersions';

export const PRICE_ROUTING_SCORE_SOURCES = [
  'provider_contract',
  'cost_model',
  'reviewed_scorecard',
] as const;

export const MEASURED_ROUTING_SCORE_SOURCES = [
  'kaana_measurement',
  'reviewed_scorecard',
] as const;

export const BALANCED_ROUTING_SCORE_SOURCES = ['cost_model', 'reviewed_scorecard'] as const;

export type PriceRoutingScoreSource = (typeof PRICE_ROUTING_SCORE_SOURCES)[number];
export type MeasuredRoutingScoreSource = (typeof MEASURED_ROUTING_SCORE_SOURCES)[number];
export type BalancedRoutingScoreSource = (typeof BALANCED_ROUTING_SCORE_SOURCES)[number];

export const inferenceDeploymentRoutingScores = pgTable(
  'inference_deployment_routing_scores',
  {
    deploymentId: text().primaryKey(),
    priceScore: integer(),
    priceSource: text({ enum: PRICE_ROUTING_SCORE_SOURCES }).notNull(),
    priceEvidenceRef: text().notNull(),
    priceVersionId: text()
      .notNull()
      .references(() => priceVersions.id, { onDelete: 'restrict' }),
    latencyScore: integer(),
    latencySource: text({ enum: MEASURED_ROUTING_SCORE_SOURCES }).notNull(),
    latencyEvidenceRef: text().notNull(),
    latencyMeasurementWindowStart: timestamptz().notNull(),
    latencyMeasurementWindowEnd: timestamptz().notNull(),
    latencyValidUntil: timestamptz().notNull(),
    throughputScore: integer(),
    throughputSource: text({ enum: MEASURED_ROUTING_SCORE_SOURCES }).notNull(),
    throughputEvidenceRef: text().notNull(),
    throughputMeasurementWindowStart: timestamptz().notNull(),
    throughputMeasurementWindowEnd: timestamptz().notNull(),
    throughputValidUntil: timestamptz().notNull(),
    balancedScore: integer(),
    balancedSource: text({ enum: BALANCED_ROUTING_SCORE_SOURCES }).notNull(),
    balancedEvidenceRef: text().notNull(),
    balancedFormulaRef: text().notNull(),
    balancedValidUntil: timestamptz().notNull(),
    reason: text().notNull(),
    changedByUserId: text().notNull(),
    changedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'inference_deployment_routing_scores_identity_check',
      sql`length(btrim(${t.deploymentId})) > 0`
    ),
    check(
      'inference_deployment_routing_scores_range_check',
      sql`(${t.priceScore} is null or ${t.priceScore} between -1000000 and 1000000)
        and (${t.latencyScore} is null or ${t.latencyScore} between -1000000 and 1000000)
        and (${t.throughputScore} is null or ${t.throughputScore} between -1000000 and 1000000)
        and (${t.balancedScore} is null or ${t.balancedScore} between -1000000 and 1000000)`
    ),
    check(
      'inference_deployment_routing_scores_source_check',
      sql`${t.priceSource} in (${sql.raw(inList(PRICE_ROUTING_SCORE_SOURCES))})
        and ${t.latencySource} in (${sql.raw(inList(MEASURED_ROUTING_SCORE_SOURCES))})
        and ${t.throughputSource} in (${sql.raw(inList(MEASURED_ROUTING_SCORE_SOURCES))})
        and ${t.balancedSource} in (${sql.raw(inList(BALANCED_ROUTING_SCORE_SOURCES))})`
    ),
    check(
      'inference_deployment_routing_scores_evidence_check',
      sql`length(btrim(${t.priceEvidenceRef})) between 1 and 500
        and length(btrim(${t.latencyEvidenceRef})) between 1 and 500
        and length(btrim(${t.throughputEvidenceRef})) between 1 and 500
        and length(btrim(${t.balancedEvidenceRef})) between 1 and 500
        and length(btrim(${t.balancedFormulaRef})) between 1 and 500
        and length(btrim(${t.reason})) between 1 and 500`
    ),
    check(
      'inference_deployment_routing_scores_measurement_windows_check',
      sql`${t.latencyMeasurementWindowEnd} >= ${t.latencyMeasurementWindowStart}
        and ${t.latencyValidUntil} >= ${t.latencyMeasurementWindowEnd}
        and ${t.throughputMeasurementWindowEnd} >= ${t.throughputMeasurementWindowStart}
        and ${t.throughputValidUntil} >= ${t.throughputMeasurementWindowEnd}`
    ),
  ]
);

/** Append-only provenance for every scorecard change accepted by the staff API. */
export const inferenceDeploymentRoutingScoreEvents = pgTable(
  'inference_deployment_routing_score_events',
  {
    id: generatedId(),
    deploymentId: text().notNull(),
    priceScore: integer(),
    priceSource: text({ enum: PRICE_ROUTING_SCORE_SOURCES }).notNull(),
    priceEvidenceRef: text().notNull(),
    priceVersionId: text()
      .notNull()
      .references(() => priceVersions.id, { onDelete: 'restrict' }),
    latencyScore: integer(),
    latencySource: text({ enum: MEASURED_ROUTING_SCORE_SOURCES }).notNull(),
    latencyEvidenceRef: text().notNull(),
    latencyMeasurementWindowStart: timestamptz().notNull(),
    latencyMeasurementWindowEnd: timestamptz().notNull(),
    latencyValidUntil: timestamptz().notNull(),
    throughputScore: integer(),
    throughputSource: text({ enum: MEASURED_ROUTING_SCORE_SOURCES }).notNull(),
    throughputEvidenceRef: text().notNull(),
    throughputMeasurementWindowStart: timestamptz().notNull(),
    throughputMeasurementWindowEnd: timestamptz().notNull(),
    throughputValidUntil: timestamptz().notNull(),
    balancedScore: integer(),
    balancedSource: text({ enum: BALANCED_ROUTING_SCORE_SOURCES }).notNull(),
    balancedEvidenceRef: text().notNull(),
    balancedFormulaRef: text().notNull(),
    balancedValidUntil: timestamptz().notNull(),
    reason: text().notNull(),
    changedByUserId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'inference_deployment_routing_score_events_identity_check',
      sql`length(btrim(${t.deploymentId})) > 0`
    ),
    check(
      'inference_deployment_routing_score_events_range_check',
      sql`(${t.priceScore} is null or ${t.priceScore} between -1000000 and 1000000)
        and (${t.latencyScore} is null or ${t.latencyScore} between -1000000 and 1000000)
        and (${t.throughputScore} is null or ${t.throughputScore} between -1000000 and 1000000)
        and (${t.balancedScore} is null or ${t.balancedScore} between -1000000 and 1000000)`
    ),
    check(
      'inference_deployment_routing_score_events_source_check',
      sql`${t.priceSource} in (${sql.raw(inList(PRICE_ROUTING_SCORE_SOURCES))})
        and ${t.latencySource} in (${sql.raw(inList(MEASURED_ROUTING_SCORE_SOURCES))})
        and ${t.throughputSource} in (${sql.raw(inList(MEASURED_ROUTING_SCORE_SOURCES))})
        and ${t.balancedSource} in (${sql.raw(inList(BALANCED_ROUTING_SCORE_SOURCES))})`
    ),
    check(
      'inference_deployment_routing_score_events_evidence_check',
      sql`length(btrim(${t.priceEvidenceRef})) between 1 and 500
        and length(btrim(${t.latencyEvidenceRef})) between 1 and 500
        and length(btrim(${t.throughputEvidenceRef})) between 1 and 500
        and length(btrim(${t.balancedEvidenceRef})) between 1 and 500
        and length(btrim(${t.balancedFormulaRef})) between 1 and 500
        and length(btrim(${t.reason})) between 1 and 500`
    ),
    check(
      'inference_deployment_routing_score_events_measurement_windows_check',
      sql`${t.latencyMeasurementWindowEnd} >= ${t.latencyMeasurementWindowStart}
        and ${t.latencyValidUntil} >= ${t.latencyMeasurementWindowEnd}
        and ${t.throughputMeasurementWindowEnd} >= ${t.throughputMeasurementWindowStart}
        and ${t.throughputValidUntil} >= ${t.throughputMeasurementWindowEnd}`
    ),
  ]
);
