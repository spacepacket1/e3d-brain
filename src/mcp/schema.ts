// Tool argument schemas: a small JSON Schema subset that dispatch validates
// every call against and that Phase 6 publishes as each tool's inputSchema.
// Validation fails closed (I10): unknown keys are always rejected (so
// `author` and `principal` can never be passed, Phase 5), nothing is coerced,
// and error messages name the argument but never echo its value (values may
// be query text or secrets).

export type Schema =
  | { type: 'string'; description?: string; minLength?: number; maxLength?: number; enum?: readonly string[]; pattern?: string }
  | { type: 'integer' | 'number'; description?: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; description?: string; items: Schema; minItems?: number; maxItems?: number }
  | ObjectSchema
  | { anyOf: readonly Schema[]; description?: string };

export interface ObjectSchema {
  type: 'object';
  description?: string;
  properties: Readonly<Record<string, Schema>>;
  required?: readonly string[];
  /** Always treated as false; present so the published schema says so. */
  additionalProperties?: false;
}

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

/** The `max_chars` argument every read tool accepts (I6). Values above the ceiling are clamped by dispatch, not rejected. */
export const MAX_CHARS_SCHEMA: Schema = {
  type: 'integer',
  minimum: 1,
  description: 'Lower the output size cap for this call; cannot raise the configured ceiling.',
};

const MAX_DEPTH = 8;

function label(path: string): string {
  return path === '' ? 'arguments' : `argument "${path}"`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function check(schema: Schema, value: unknown, path: string, depth: number): string | undefined {
  if (depth > MAX_DEPTH) return `${label(path)} is nested too deeply`;
  if ('anyOf' in schema) {
    return schema.anyOf.some((s) => check(s, value, path, depth + 1) === undefined)
      ? undefined
      : `${label(path)} does not match any allowed form`;
  }
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') return `${label(path)} must be a string`;
      if (schema.minLength !== undefined && value.length < schema.minLength) return `${label(path)} is too short`;
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${label(path)} is too long`;
      if (schema.enum !== undefined && !schema.enum.includes(value)) return `${label(path)} is not an allowed value`;
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) return `${label(path)} has an invalid format`;
      return undefined;
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${label(path)} must be ${schema.type === 'integer' ? 'an integer' : 'a number'}`;
      if (schema.type === 'integer' && !Number.isSafeInteger(value)) return `${label(path)} must be an integer`;
      if (schema.minimum !== undefined && value < schema.minimum) return `${label(path)} is below the minimum`;
      if (schema.maximum !== undefined && value > schema.maximum) return `${label(path)} is above the maximum`;
      return undefined;
    }
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `${label(path)} must be a boolean`;
    case 'array': {
      if (!Array.isArray(value)) return `${label(path)} must be an array`;
      if (schema.minItems !== undefined && value.length < schema.minItems) return `${label(path)} has too few items`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${label(path)} has too many items`;
      for (let i = 0; i < value.length; i++) {
        const err = check(schema.items, value[i], `${path}[${i}]`, depth + 1);
        if (err !== undefined) return err;
      }
      return undefined;
    }
    case 'object': {
      if (!isPlainObject(value)) return `${label(path)} must be an object`;
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, key)) {
          // Name the key only when it is short and printable; it is caller text.
          const shown = /^[A-Za-z0-9_]{1,64}$/.test(key) ? `"${key}"` : '(unprintable)';
          return `${label(path)}: unknown key ${shown}`;
        }
      }
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) return `${label(path === '' ? key : `${path}.${key}`)} is required`;
      }
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (!Object.hasOwn(value, key)) continue;
        const err = check(sub, value[key], path === '' ? key : `${path}.${key}`, depth + 1);
        if (err !== undefined) return err;
      }
      return undefined;
    }
  }
}

/** Validate `value` against `schema`; returns an error message or undefined. */
export function validate(schema: Schema, value: unknown): string | undefined {
  return check(schema, value, '', 0);
}

/** Check that a tool's schema is well-formed at registration (fail early, not per call). */
export function assertToolSchema(schema: ObjectSchema): void {
  const walk = (s: Schema, depth: number): void => {
    if (depth > MAX_DEPTH) throw new SchemaError('schema is nested too deeply');
    if ('anyOf' in s) {
      if (s.anyOf.length === 0) throw new SchemaError('anyOf must not be empty');
      for (const sub of s.anyOf) walk(sub, depth + 1);
      return;
    }
    switch (s.type) {
      case 'string':
        if (s.pattern !== undefined) new RegExp(s.pattern, 'u');
        return;
      case 'integer':
      case 'number':
      case 'boolean':
        return;
      case 'array':
        walk(s.items, depth + 1);
        return;
      case 'object':
        if (typeof s.properties !== 'object' || s.properties === null) throw new SchemaError('object schema needs properties');
        if ((s as { additionalProperties?: unknown }).additionalProperties !== undefined && s.additionalProperties !== false) {
          throw new SchemaError('additionalProperties may only be false');
        }
        for (const key of s.required ?? []) {
          if (!Object.hasOwn(s.properties, key)) throw new SchemaError(`required key "${key}" is not a property`);
        }
        for (const sub of Object.values(s.properties)) walk(sub, depth + 1);
        return;
      default:
        throw new SchemaError('unsupported schema type');
    }
  };
  if (schema.type !== 'object') throw new SchemaError('a tool schema must be an object schema');
  walk(schema, 0);
}
