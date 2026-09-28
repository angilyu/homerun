import type { z } from "zod";

/**
 * Every schema that is part of the public contract is registered here under a stable
 * name. The name becomes its `$defs` key in the exported JSON Schema and the `schema`
 * field of golden vectors, so renaming one is a protocol change.
 */
const NAMED = new Map<string, z.ZodType>();

export function named<T extends z.ZodType>(id: string, schema: T, description?: string): T {
  if (NAMED.has(id)) throw new Error(`duplicate schema id ${id}`);
  const withMeta = schema.meta(description ? { id, description } : { id }) as T;
  NAMED.set(id, withMeta);
  return withMeta;
}

export function namedSchemas(): ReadonlyMap<string, z.ZodType> {
  return NAMED;
}

export function schemaById(id: string): z.ZodType | undefined {
  return NAMED.get(id);
}
