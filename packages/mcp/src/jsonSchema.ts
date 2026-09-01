import { z } from 'zod';

export type JsonSchema = Parameters<typeof z.fromJSONSchema>[0];

/**
 * Convert standards-compliant JSON Schema with Zod's maintained converter.
 * This keeps composition, formats and numeric/string/array/object constraints
 * aligned with the schema advertised through MCP.
 */
export function jsonSchemaToZod(schema: JsonSchema): z.ZodType {
  return z.fromJSONSchema(schema);
}

export function jsonObjectSchemaToZod(schema: JsonSchema): z.ZodType {
  if (typeof schema !== 'object' || schema.type !== 'object') {
    throw new Error('MCP tool schemas must have object roots');
  }
  return jsonSchemaToZod(schema);
}
