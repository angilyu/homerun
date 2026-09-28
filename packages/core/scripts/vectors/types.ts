/**
 * A golden vector. `schema` names a `$defs` entry of `schema/homerun.schema.json`.
 *
 * Invalid vectors say which layer must reject them:
 * - `json_schema`: the exported JSON Schema rejects it, so any validator will;
 * - `refinement`: only a rule JSON Schema cannot express rejects it (cron grammar, IANA zone,
 *   cross-field checks). Other-language clients must implement these by hand; see the README.
 */
export type Vector =
  | { schema: string; name: string; valid: true; value: unknown }
  | { schema: string; name: string; valid: false; layer: "json_schema" | "refinement"; value: unknown };

export const ok = (schema: string, name: string, value: unknown): Vector => ({ schema, name, valid: true, value });
export const bad = (schema: string, name: string, value: unknown): Vector => ({ schema, name, valid: false, layer: "json_schema", value });
export const badRule = (schema: string, name: string, value: unknown): Vector => ({ schema, name, valid: false, layer: "refinement", value });

/** Deep-clone `v` and apply `f` to the clone. */
export function edit<T>(v: T, f: (x: any) => void): T {
  const c = structuredClone(v);
  f(c);
  return c;
}
