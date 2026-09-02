import type { CatalogTool, GrantLimit } from '@oxyhq/contracts';

function duplicateLimit(limits: readonly GrantLimit[]): boolean {
  const keys = limits.map((limit) => `${limit.tool}\0${limit.key}`);
  return new Set(keys).size !== keys.length;
}

/**
 * A persisted limit must be a catalog-declared scalar constraint, never an
 * invocation argument. Catalogs registered before `limitKeys` existed are
 * treated as declaring no persistable limits.
 */
export function capabilityLimitError(
  limits: readonly GrantLimit[],
  tools: readonly CatalogTool[],
  resourceType: string,
): string | null {
  if (duplicateLimit(limits)) return 'duplicate_limit';
  for (const limit of limits) {
    const tool = tools.find((entry) => entry.name === limit.tool);
    if (!tool || !tool.exposure.includes('internal') || !tool.resourceTypes.includes(resourceType)) {
      return 'limit_tool_not_available_for_resource';
    }
    const declaration = (tool.limitKeys ?? []).find((entry) => entry.key === limit.key);
    if (!declaration) return 'limit_key_not_declared_by_tool';
    if (declaration.kind === 'maximum_number' && typeof limit.value !== 'number') {
      return 'limit_value_kind_mismatch';
    }
    if (declaration.kind === 'exact_boolean' && typeof limit.value !== 'boolean') {
      return 'limit_value_kind_mismatch';
    }
  }
  return null;
}
