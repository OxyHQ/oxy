export interface MediaAccessContext {
  app?: string;
  entityType?: string;
  entityId?: string;
  postVisibility?: string; // 'public', 'followers', 'mentioned', 'private'
  authorId?: string;
}

export interface MediaAccessResult {
  allowed: boolean;
  reason?: string;
  isPublic?: boolean; // True if file is completely public (no auth needed)
}

export interface EntityAccessResult {
  allowed: boolean;
  cacheable?: boolean;
  ttl?: number; // seconds
}

