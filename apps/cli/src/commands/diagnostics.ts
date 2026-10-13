import { existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { isAbsolute, join, resolve } from "node:path";
import type { DiagnosticFile } from "@homerun/core";
import type { Ctx } from "../context";
import { CliError, EXIT, usageError } from "../exit";
import { bytes, table } from "../format";

/**
 * `homerun diagnostics` (§11 Diagnostics): the runtime writes a redacted zip, the same bundle as
 * Settings → Create diagnostic bundle. It lists the files first and asks, unless --yes; nothing
 * is uploaded. The list and the question go to stderr, the saved path to stdout.
 */
export async function diagnostics(x: Ctx): Promise<number> {
  const { c, o, io, values } = x;
  const path = values.out === undefined ? undefined : target(String(values.out), new Date());
  const { files } = await c.call("diagnostics.preview", {});
  if (!o.json || !values.yes) {
    o.note(`The bundle will contain (${bytes(files.reduce((n, f) => n + f.bytes, 0))} before compression):`);
    o.note(listing(files));
    o.note(o.ce.dim("Logs are redacted; the database is counted, not copied. Nothing is uploaded."));
  }
  if (!values.yes) {
    if (!io.stdin.isTTY) throw usageError("add --yes to write the bundle without asking");
    if (!(await confirm(x, `Save it ${path ? `as ${path}` : "to Downloads"}? [y/N] `))) {
      o.note("Not saved.");
      return EXIT.OK;
    }
  }
  const r = await c.call("diagnostics.create", path ? { path } : {});
  if (o.json) return o.value(r), EXIT.OK;
  o.note(`Saved (${bytes(r.bytes)}):`);
  o.line(r.path);
  return EXIT.OK;
}

/** --out: a .zip path, or a folder for a dated name in it. Relative to the working directory. */
export function target(out: string, now: Date): string {
  const p = isAbsolute(out) ? out : resolve(out);
  if (existsSync(p) && statSync(p).isDirectory()) {
    const d = (n: number) => String(n).padStart(2, "0");
    const stem = `homerun-diagnostics-${now.getFullYear()}${d(now.getMonth() + 1)}${d(now.getDate())}-${d(now.getHours())}${d(now.getMinutes())}${d(now.getSeconds())}`;
    return join(p, `${stem}.zip`);
  }
  if (!p.toLowerCase().endsWith(".zip")) throw usageError("--out must be a folder or a file name ending in .zip");
  if (existsSync(p)) throw new CliError(`${p} already exists`);
  return p;
}

export function listing(files: DiagnosticFile[]): string {
  return table(files.map((f) => [`  ${f.name}`, bytes(f.bytes), f.description])).trimEnd();
}

async function confirm(x: Ctx, question: string): Promise<boolean> {
  const rl = createInterface({ input: x.io.stdin, output: x.io.stderr as unknown as NodeJS.WritableStream, terminal: true });
  try {
    const answer = await new Promise<string>((done) => {
      rl.question(question, done);
      rl.once("close", () => done(""));
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
