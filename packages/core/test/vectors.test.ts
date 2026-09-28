import { describe, expect, test } from "bun:test";
import { schemaById } from "../src/index";
import { jsonSchemaValidator, loadVectors } from "./helpers";

const groups = loadVectors();
const validateJson = jsonSchemaValidator();

for (const [group, cases] of Object.entries(groups)) {
  describe(`vectors/${group}.json`, () => {
    test("names are unique per schema", () => {
      const keys = cases.map((c) => `${c.schema} :: ${c.name} :: ${c.valid}`);
      expect(new Set(keys).size).toBe(keys.length);
    });

    for (const c of cases) {
      const label = `${c.valid ? "accepts" : "rejects"} ${c.schema}: ${c.name}`;
      test(label, () => {
        const schema = schemaById(c.schema);
        if (!schema) throw new Error(`unknown schema ${c.schema}`);
        const r = schema.safeParse(c.value);
        if (c.valid) {
          if (!r.success) throw new Error(r.error.message);
          // Serialize: parsing a valid vector returns it unchanged, and survives JSON.
          expect(r.data).toEqual(c.value);
          expect(schema.parse(JSON.parse(JSON.stringify(r.data)))).toEqual(c.value);
          expect(validateJson(c.schema, c.value)).toBe(true);
        } else {
          expect(r.success).toBe(false);
          // json_schema: any JSON Schema validator rejects it. refinement: only hand-written rules
          // do, so JSON Schema must accept it (or the vector is misclassified).
          expect(validateJson(c.schema, c.value)).toBe(c.layer === "refinement");
        }
      });
    }
  });
}
