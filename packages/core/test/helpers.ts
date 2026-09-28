import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import type { Vector } from "../scripts/vectors/types";

export const PKG = join(import.meta.dir, "..");

export function loadVectors(): Record<string, Vector[]> {
  const dir = join(PKG, "vectors");
  const out: Record<string, Vector[]> = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "answer-rules.json").sort()) {
    out[f.replace(/\.json$/, "")] = JSON.parse(readFileSync(join(dir, f), "utf8")).cases;
  }
  return out;
}

export function loadBundle(): Record<string, any> {
  return JSON.parse(readFileSync(join(PKG, "schema/homerun.schema.json"), "utf8"));
}

/** Ajv over the committed bundle, the way a non-TypeScript client would validate. */
export function jsonSchemaValidator() {
  const bundle = loadBundle();
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  ajv.addSchema(bundle);
  const cache = new Map<string, ReturnType<typeof ajv.compile>>();
  return (schema: string, value: unknown) => {
    let v = cache.get(schema);
    if (!v) {
      const got = ajv.getSchema(`${bundle.$id}#/$defs/${schema}`);
      if (!got) throw new Error(`no $defs/${schema} in bundle`);
      v = got;
      cache.set(schema, v);
    }
    return v(value) as boolean;
  };
}
