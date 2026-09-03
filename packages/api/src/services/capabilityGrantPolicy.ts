import type {
  AppCapabilityCatalog,
  AutonomyLevel,
  CapabilityPackage,
  CatalogTool,
  GrantLimit,
  ToolGrantOverride,
} from '@oxyhq/contracts';
import { capabilityLimitError } from './capabilityLimitPolicy';

export const SENSITIVE_CAPABILITY_PACKAGES: ReadonlySet<CapabilityPackage> = new Set([
  'finance',
  'security',
  'delegate',
]);

interface CapabilityGrantPolicyInput {
  readonly resourceType: string;
  readonly capabilityPackages: readonly CapabilityPackage[];
  readonly capabilities: readonly string[];
  readonly toolOverrides: readonly ToolGrantOverride[];
  readonly limits: readonly GrantLimit[];
  readonly maximumAutonomy: AutonomyLevel;
}

interface GrantToolAuthority {
  readonly capabilityPackages: readonly CapabilityPackage[];
  readonly capabilities: readonly string[];
  readonly overrides: readonly ToolGrantOverride[];
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function applicableInternalTools(
  catalog: AppCapabilityCatalog,
  resourceType: string,
): CatalogTool[] {
  return catalog.tools.filter((tool) => (
    tool.exposure.includes('internal') && tool.resourceTypes.includes(resourceType)
  ));
}

export function capabilityGrantError(
  input: CapabilityGrantPolicyInput,
  catalog: AppCapabilityCatalog,
): string | null {
  const tools = applicableInternalTools(catalog, input.resourceType);
  if (tools.length === 0) return 'resource_type_not_available_in_catalog';

  if (hasDuplicates(input.capabilityPackages)) return 'duplicate_capability_package';
  const availablePackages = new Set(tools.map((tool) => tool.capabilityPackage));
  if (input.capabilityPackages.some((capabilityPackage) => !availablePackages.has(capabilityPackage))) {
    return 'capability_package_not_available_for_resource';
  }

  if (hasDuplicates(input.capabilities)) return 'duplicate_capability';
  const availableCapabilities = new Set(tools.flatMap((tool) => tool.requiredCapabilities));
  if (input.capabilities.some((capability) => !availableCapabilities.has(capability))) {
    return 'capability_not_available_for_resource';
  }

  if (hasDuplicates(input.toolOverrides.map((override) => override.tool))) {
    return 'duplicate_tool_override';
  }
  for (const override of input.toolOverrides) {
    const tool = tools.find((entry) => entry.name === override.tool);
    if (!tool) return 'override_tool_not_available_for_resource';
    if (override.decision === 'allow'
      && SENSITIVE_CAPABILITY_PACKAGES.has(tool.capabilityPackage)
      && tool.requiredCapabilities.some((capability) => !input.capabilities.includes(capability))) {
      return 'sensitive_tool_requires_explicit_capabilities';
    }
  }

  const limitError = capabilityLimitError(input.limits, tools, input.resourceType);
  if (limitError) return limitError;
  for (const tool of tools) {
    if (!grantAllowsTool(tool, {
      capabilityPackages: input.capabilityPackages,
      capabilities: input.capabilities,
      overrides: input.toolOverrides,
    }, tool)) continue;
    const autonomyLimitError = autonomousSensitiveToolLimitError(
      input.maximumAutonomy,
      tool,
      input.limits,
    );
    if (autonomyLimitError) return autonomyLimitError;
  }
  return null;
}

export function catalogToolAuthorizationShapeMatches(
  current: CatalogTool,
  bound: CatalogTool | undefined,
): boolean {
  if (!bound) return false;
  const currentCapabilities = [...current.requiredCapabilities].sort();
  const boundCapabilities = [...bound.requiredCapabilities].sort();
  const currentResourceTypes = [...current.resourceTypes].sort();
  const boundResourceTypes = [...bound.resourceTypes].sort();
  return current.name === bound.name
    && current.capabilityPackage === bound.capabilityPackage
    && current.effect === bound.effect
    && currentCapabilities.length === boundCapabilities.length
    && currentCapabilities.every((capability, index) => capability === boundCapabilities[index])
    && currentResourceTypes.length === boundResourceTypes.length
    && currentResourceTypes.every((resourceType, index) => resourceType === boundResourceTypes[index]);
}

export function grantAllowsTool(
  tool: CatalogTool,
  grant: GrantToolAuthority,
  boundTool: CatalogTool | undefined,
): boolean {
  const override = grant.overrides.find((entry) => entry.tool === tool.name);
  if (override?.decision === 'deny') return false;
  if (tool.requiredCapabilities.every((capability) => grant.capabilities.includes(capability))) return true;
  if (SENSITIVE_CAPABILITY_PACKAGES.has(tool.capabilityPackage)) return false;
  if (override?.decision === 'allow') {
    return catalogToolAuthorizationShapeMatches(tool, boundTool);
  }
  return grant.capabilityPackages.includes(tool.capabilityPackage);
}

export function autonomousSensitiveToolLimitError(
  maximumAutonomy: AutonomyLevel,
  tool: CatalogTool,
  limits: readonly GrantLimit[],
): string | null {
  if (maximumAutonomy !== 'autonomous' || (tool.effect !== 'financial' && tool.effect !== 'security')) {
    return null;
  }
  if (tool.limitKeys.length === 0) return 'autonomous_sensitive_tool_has_no_limit_keys';
  const suppliedKeys = new Set(
    limits.filter((limit) => limit.tool === tool.name).map((limit) => limit.key),
  );
  return tool.limitKeys.some((limit) => !suppliedKeys.has(limit.key))
    ? 'autonomous_sensitive_tool_limit_required'
    : null;
}
