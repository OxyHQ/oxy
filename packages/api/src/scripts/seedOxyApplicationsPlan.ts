/**
 * Reconciliation decision for `scripts/seed-oxy-applications.ts`, extracted as
 * pure functions so `DRY_RUN` and the real run cannot disagree.
 *
 * Same structural invariant as `registerCommonsClientsPlan.ts`: compute
 * unconditionally, write only when not dry-run.
 */

import type { ApplicationStatus, ApplicationType } from '../db/schema/applications';
import type { ApplicationCapability } from '../utils/applicationCapabilities';
import type { ApplicationScope } from '../utils/applicationScopes';

export const ABSENT = '(absent)';
const NONE = '(none)';

export interface SeedApplicationState {
  description: string;
  websiteUrl: string | null;
  status: ApplicationStatus;
  type: ApplicationType;
  isOfficial: boolean;
  isInternal: boolean;
  ownerAccountId: string;
  redirectUris: string[];
  scopes: ApplicationScope[];
  capabilities: string[];
}

export interface SeedApplicationTarget {
  description: string;
  websiteUrl?: string;
  type: ApplicationType;
  ownerAccountId: string;
  redirectUris: readonly string[];
  scopes: readonly ApplicationScope[];
  capabilities: readonly ApplicationCapability[];
}

export type SeedApplicationField = keyof SeedApplicationState;

export interface PlannedSeedFieldChange {
  field: SeedApplicationField;
  from: string;
  to: string;
}

export interface SeedApplicationPlan {
  creates: boolean;
  changes: PlannedSeedFieldChange[];
  desired: SeedApplicationState;
}

export interface MutableSeedApplicationFields {
  description: string;
  websiteUrl: string | null;
  status: ApplicationStatus;
  type: ApplicationType;
  isOfficial: boolean;
  isInternal: boolean;
  ownerAccountId: string;
  redirectUris: string[];
  scopes: ApplicationScope[];
  capabilities: string[];
}

export interface ReadableSeedApplication {
  description: string | null;
  websiteUrl?: string | null;
  status: ApplicationStatus;
  type: ApplicationType;
  isOfficial: boolean;
  isInternal: boolean;
  ownerAccountId: string;
  redirectUris?: string[] | null;
  scopes?: string[] | null;
  capabilities?: string[] | null;
}

function union<T extends string>(current: readonly T[], additions: readonly T[]): T[] {
  return Array.from(new Set<T>([...current, ...additions]));
}

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : NONE;
}

function normalizeWebsiteUrl(value: string | null | undefined): string | null {
  return value ?? null;
}

export function readSeedApplicationState(application: ReadableSeedApplication): SeedApplicationState {
  return {
    description: application.description ?? '',
    websiteUrl: normalizeWebsiteUrl(application.websiteUrl),
    status: application.status,
    type: application.type,
    isOfficial: application.isOfficial,
    isInternal: application.isInternal,
    ownerAccountId: application.ownerAccountId,
    redirectUris: [...(application.redirectUris ?? [])],
    scopes: [...(application.scopes ?? [])] as ApplicationScope[],
    capabilities: [...(application.capabilities ?? [])],
  };
}

export function computeSeedApplicationPlan(
  current: SeedApplicationState | null,
  target: SeedApplicationTarget,
): SeedApplicationPlan {
  const desired: SeedApplicationState = {
    description: target.description,
    websiteUrl: normalizeWebsiteUrl(target.websiteUrl),
    status: 'active',
    type: target.type,
    isOfficial: true,
    isInternal: target.type === 'internal',
    ownerAccountId: target.ownerAccountId,
    redirectUris: union(current?.redirectUris ?? [], target.redirectUris),
    scopes: union(current?.scopes ?? [], target.scopes),
    capabilities: union(current?.capabilities ?? [], target.capabilities),
  };

  if (!current) {
    return {
      creates: true,
      changes: [
        { field: 'description', from: ABSENT, to: desired.description },
        {
          field: 'websiteUrl',
          from: ABSENT,
          to: desired.websiteUrl ?? NONE,
        },
        { field: 'status', from: ABSENT, to: desired.status },
        { field: 'type', from: ABSENT, to: desired.type },
        { field: 'isOfficial', from: ABSENT, to: String(desired.isOfficial) },
        { field: 'isInternal', from: ABSENT, to: String(desired.isInternal) },
        { field: 'ownerAccountId', from: ABSENT, to: desired.ownerAccountId },
        { field: 'redirectUris', from: ABSENT, to: formatList(desired.redirectUris) },
        { field: 'scopes', from: ABSENT, to: formatList(desired.scopes) },
        { field: 'capabilities', from: ABSENT, to: formatList(desired.capabilities) },
      ],
      desired,
    };
  }

  const changes: PlannedSeedFieldChange[] = [];

  if (current.description !== desired.description) {
    changes.push({ field: 'description', from: current.description, to: desired.description });
  }
  if (normalizeWebsiteUrl(current.websiteUrl) !== desired.websiteUrl) {
    changes.push({
      field: 'websiteUrl',
      from: current.websiteUrl ?? NONE,
      to: desired.websiteUrl ?? NONE,
    });
  }
  if (current.status !== desired.status) {
    changes.push({ field: 'status', from: current.status, to: desired.status });
  }
  if (current.type !== desired.type) {
    changes.push({ field: 'type', from: current.type, to: desired.type });
  }
  if (current.isOfficial !== desired.isOfficial) {
    changes.push({
      field: 'isOfficial',
      from: String(current.isOfficial),
      to: String(desired.isOfficial),
    });
  }
  if (current.isInternal !== desired.isInternal) {
    changes.push({
      field: 'isInternal',
      from: String(current.isInternal),
      to: String(desired.isInternal),
    });
  }
  if (current.ownerAccountId !== desired.ownerAccountId) {
    changes.push({
      field: 'ownerAccountId',
      from: current.ownerAccountId,
      to: desired.ownerAccountId,
    });
  }
  if (!sameSequence(current.redirectUris, desired.redirectUris)) {
    changes.push({
      field: 'redirectUris',
      from: formatList(current.redirectUris),
      to: formatList(desired.redirectUris),
    });
  }
  if (!sameSequence(current.scopes, desired.scopes)) {
    changes.push({
      field: 'scopes',
      from: formatList(current.scopes),
      to: formatList(desired.scopes),
    });
  }
  if (!sameSequence(current.capabilities, desired.capabilities)) {
    changes.push({
      field: 'capabilities',
      from: formatList(current.capabilities),
      to: formatList(desired.capabilities),
    });
  }

  return { creates: false, changes, desired };
}

export function applySeedApplicationPlan(
  target: MutableSeedApplicationFields,
  plan: SeedApplicationPlan,
): SeedApplicationField[] {
  const written: SeedApplicationField[] = [];

  for (const { field } of plan.changes) {
    switch (field) {
      case 'description':
        target.description = plan.desired.description;
        break;
      case 'websiteUrl':
        target.websiteUrl = plan.desired.websiteUrl;
        break;
      case 'status':
        target.status = plan.desired.status;
        break;
      case 'type':
        target.type = plan.desired.type;
        break;
      case 'isOfficial':
        target.isOfficial = plan.desired.isOfficial;
        break;
      case 'isInternal':
        target.isInternal = plan.desired.isInternal;
        break;
      case 'ownerAccountId':
        target.ownerAccountId = plan.desired.ownerAccountId;
        break;
      case 'redirectUris':
        target.redirectUris = [...plan.desired.redirectUris];
        break;
      case 'scopes':
        target.scopes = [...plan.desired.scopes];
        break;
      case 'capabilities':
        target.capabilities = [...plan.desired.capabilities];
        break;
      default: {
        const unhandled: never = field;
        throw new Error(`Unhandled seed application field in plan: ${String(unhandled)}`);
      }
    }
    written.push(field);
  }

  return written;
}
