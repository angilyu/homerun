import { VERIFIERS } from "@homerun/protocol";
import { VECTOR_FILES } from "@homerun/protocol/vector-files";

/**
 * The protocol vectors (§16.2) under the phone's own JavaScript engine: the nightly simulator job
 * launches the app with `-HomerunSelfTest 1` and reads the result line. App Attest attestations are
 * verified by desktops and the relay, never by the phone, so that file isn't the phone's to pass.
 */
export const PHONE_VECTOR_FILES = Object.keys(VERIFIERS).filter((f) => f !== "app-attest.json");

export interface SelfTest {
  passed: number;
  /** "file: case" of each failure; the vectors are public test data. */
  failed: string[];
}

export async function runSelfTest(): Promise<SelfTest> {
  const r: SelfTest = { passed: 0, failed: [] };
  for (const file of PHONE_VECTOR_FILES) {
    for (const c of await VERIFIERS[file]!(VECTOR_FILES[file])) {
      if (c.ok) r.passed++;
      else r.failed.push(`${c.file}: ${c.name}`);
    }
  }
  return r;
}

export const selfTestLine = (r: SelfTest) =>
  r.failed.length ? `vectors: ${r.passed} passed, ${r.failed.length} failed (${r.failed.join("; ")})` : `vectors: ${r.passed} passed`;
