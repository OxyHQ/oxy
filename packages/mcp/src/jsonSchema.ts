import { z } from 'zod';

type JsonSchemaRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonSchemaRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValues(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return null;
  return value;
}

export function jsonSchemaToZod(schema: JsonSchemaRecord): z.ZodType {
  const nullable = schema.nullable === true;
  let result: z.ZodType;

  switch (schema.type) {
    case 'string': {
      let stringSchema = z.string();
      if (typeof schema.minLength === 'number') stringSchema = stringSchema.min(schema.minLength);
      if (typeof schema.maxLength === 'number') stringSchema = stringSchema.max(schema.maxLength);
      const allowed = stringValues(schema.enum);
      result = allowed
        ? stringSchema.refine((value) => allowed.includes(value), { message: 'Value is not in the allowed enum' })
        : stringSchema;
      break;
    }
    case 'integer':
      result = z.number().int();
      break;
    case 'number':
      result = z.number().finite();
      break;
    case 'boolean':
      result = z.boolean();
      break;
    case 'array': {
      const items = isRecord(schema.items) ? jsonSchemaToZod(schema.items) : z.unknown();
      result = z.array(items);
      break;
    }
    default: {
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const required = new Set(stringValues(schema.required) ?? []);
      const shape: z.ZodRawShape = {};
      for (const [name, property] of Object.entries(properties)) {
        const propertySchema = isRecord(property) ? jsonSchemaToZod(property) : z.unknown();
        shape[name] = required.has(name) ? propertySchema : propertySchema.optional();
      }
      const objectSchema = z.object(shape);
      result = schema.additionalProperties === false ? objectSchema.strict() : objectSchema.passthrough();
      break;
    }
  }

  return nullable ? result.nullable() : result;
}

export function jsonObjectSchemaToZod(schema: JsonSchemaRecord): z.ZodObject<z.ZodRawShape> {
  const converted = jsonSchemaToZod({ ...schema, type: 'object', nullable: false });
  if (!(converted instanceof z.ZodObject)) {
    throw new Error('MCP tool schemas must describe JSON objects');
  }
  return converted;
}
