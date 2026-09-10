export const OXY_ACTIVITY_ID_HEADER = 'X-Oxy-Activity-Id';
export const OXY_EDGE_REGION_HEADER = 'X-Oxy-Edge-Region';

export interface AnonymousActivityMetadata {
  activityId?: string;
  edgePop?: string;
}

export interface ActivityAggregate {
  sourceRegion?: string;
  targetRegion: string;
  service: string;
  requests: number;
  activeClients: number;
  windowStartedAt: string;
  emittedAt: string;
  direction: 'inbound';
}
