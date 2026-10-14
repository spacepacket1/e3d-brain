// Strict output schemas for LLM jobs. Model output is untrusted: it is parsed
// as JSON (an optional ```json fence is tolerated, nothing else), the
// envelope must be exactly `{ "<listKey>": [ ... ] }`, and every item must
// match its schema exactly (no missing, extra, or mistyped fields). Invalid
// items are dropped and counted; an unparseable response counts as one
// invalid response. Nothing here throws on model output.

export type FieldSpec =
  | { type: 'string'; min: number; max: number }
  | { type: 'enum'; values: readonly string[] }
  | { type: 'int'; min: number; max: number };

export type ItemSchema = Readonly<Record<string, FieldSpec>>;

export interface ValidatedOutput<T> {
  /** False when the response was not JSON or not the expected envelope. */
  parsed: boolean;
  items: T[];
  /** Items dropped for not matching the schema (including items over `maxItems`). */
  invalid: number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse a completion as JSON. Accepts bare JSON or one fenced ```json block. */
export function parseJsonOutput(text: string): unknown {
  let t = text.trim();
  const fenced = /^```(?:json)?[ \t]*\n([\s\S]*?)\n```$/.exec(t);
  if (fenced !== null) t = fenced[1]!.trim();
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

function fieldOk(spec: FieldSpec, v: unknown): boolean {
  switch (spec.type) {
    case 'string':
      return typeof v === 'string' && v.trim().length >= spec.min && v.length <= spec.max;
    case 'enum':
      return typeof v === 'string' && spec.values.includes(v);
    case 'int':
      return typeof v === 'number' && Number.isInteger(v) && v >= spec.min && v <= spec.max;
  }
}

/** True when `item` has exactly the schema's fields, each valid. */
export function matchesSchema(item: unknown, schema: ItemSchema): boolean {
  if (!isObject(item)) return false;
  const keys = Object.keys(item);
  if (keys.length !== Object.keys(schema).length) return false;
  return keys.every((k) => Object.hasOwn(schema, k) && fieldOk(schema[k]!, item[k]));
}

export function validateOutput<T>(text: string, listKey: string, schema: ItemSchema, maxItems: number): ValidatedOutput<T> {
  const raw = parseJsonOutput(text);
  if (!isObject(raw) || Object.keys(raw).length !== 1 || !Array.isArray(raw[listKey])) return { parsed: false, items: [], invalid: 0 };
  const list = raw[listKey] as unknown[];
  const items: T[] = [];
  let invalid = 0;
  for (const item of list) {
    if (items.length < maxItems && matchesSchema(item, schema)) items.push(item as T);
    else invalid++;
  }
  return { parsed: true, items, invalid };
}
