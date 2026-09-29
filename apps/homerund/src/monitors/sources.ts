import { createHash } from "node:crypto";
import { realpathSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { CheckSpec, JsonValue } from "@homerun/core";
import { RUNTIME_VERSION } from "../config";
import { parseFeed } from "./feed";

export type RuleCheck = Extract<CheckSpec, { kind: "rule" }>;
export type RuleSource = RuleCheck["source"];

/** Limits on what a rule-check source may fetch (§8.3). */
export const SOURCE_TIMEOUT_MS = 30_000;
export const SOURCE_MAX_BYTES = 5 * 1024 * 1024;

/** A failure to observe the source: the run fails with this code and message. */
export class SourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

export interface ObservedItem {
  id: string;
  title: string;
}

/** What a source showed: a value to compare, and, when it is a list, its items. */
export interface Observation {
  value: JsonValue;
  items: ObservedItem[] | null;
}

export interface ObserveOptions {
  /** The task's `policy.roots`: a `file_hash` path must be inside one (§5.5). */
  roots: readonly string[];
  userHome: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export async function observe(source: RuleSource, o: ObserveOptions): Promise<Observation> {
  switch (source.type) {
    case "http": {
      const body = await fetchText(source.url, o);
      return extract(body, source.extract);
    }
    case "feed": {
      const body = await fetchText(source.url, o);
      let items;
      try {
        items = parseFeed(body, source.format);
      } catch (e) {
        throw new SourceError("source_unreadable", `${source.url}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return { value: items.map((i) => i.id), items: items.map((i) => ({ id: i.id, title: i.title || i.link || i.id })) };
    }
    case "file_hash":
      return { value: fileHash(source.path, o), items: null };
    case "homerun_tool":
      throw new SourceError("unsupported_source", "Homerun's own tools arrive in a later version of Homerun.");
  }
}

// ---------------------------------------------------------------- http

async function fetchText(url: string, o: ObserveOptions): Promise<string> {
  const timeout = AbortSignal.timeout(o.timeoutMs ?? SOURCE_TIMEOUT_MS);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(url, { redirect: "follow", signal, headers: { "user-agent": `Homerun/${RUNTIME_VERSION}`, accept: "*/*" } });
  } catch (e) {
    if (timeout.aborted) throw new SourceError("source_timeout", `${url} did not answer within ${Math.round((o.timeoutMs ?? SOURCE_TIMEOUT_MS) / 1000)} s.`);
    throw new SourceError("source_unreachable", `${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new SourceError("source_http_error", `${url} answered HTTP ${res.status}.`);
  }
  const max = o.maxBytes ?? SOURCE_MAX_BYTES;
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw new SourceError("source_too_large", `${url} is larger than ${Math.round(max / 1024 / 1024)} MB.`);
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof SourceError) throw e;
    if (timeout.aborted) throw new SourceError("source_timeout", `${url} did not finish within ${Math.round((o.timeoutMs ?? SOURCE_TIMEOUT_MS) / 1000)} s.`);
    throw new SourceError("source_unreachable", `${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

type HttpExtract = Extract<RuleSource, { type: "http" }>["extract"];

async function extract(body: string, x: HttpExtract): Promise<Observation> {
  switch (x.kind) {
    case "body":
      return { value: body, items: null };
    case "json_path": {
      let doc: unknown;
      try {
        doc = JSON.parse(body);
      } catch {
        throw new SourceError("source_unreadable", "The response is not JSON.");
      }
      const value = jsonPath(doc, x.path);
      return { value: value as JsonValue, items: Array.isArray(value) ? value.map((v) => itemOf(v)) : null };
    }
    case "css": {
      const texts = await cssTexts(body, x.selector);
      return { value: texts.join("\n"), items: texts.map((t) => ({ id: t, title: t })) };
    }
    case "regex": {
      let re: RegExp;
      try {
        re = new RegExp(x.pattern);
      } catch (e) {
        throw new SourceError("invalid_check", `Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
      }
      const m = re.exec(body);
      const g = x.group ?? (m && m.length > 1 ? 1 : 0);
      return { value: m ? (m[g] ?? null) : null, items: null };
    }
  }
}

function itemOf(v: unknown, idField?: string): ObservedItem {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const id = idField !== undefined && o[idField] !== undefined ? String(o[idField]) : JSON.stringify(v);
    const title = typeof o.title === "string" ? o.title : typeof o.name === "string" ? o.name : id;
    return { id, title };
  }
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return { id: s, title: s };
}

/** Items of an observed list, keyed by `id_field` when given (§8.3 `new_items`). */
export function itemsWithId(obs: Observation, idField: string | undefined): ObservedItem[] | null {
  if (idField !== undefined && Array.isArray(obs.value)) return obs.value.map((v) => itemOf(v, idField));
  return obs.items;
}

/**
 * The JSON path subset rule checks accept: `$`, `.key`, `['key']` or `["key"]`, and `[n]`.
 * A missing step gives null rather than an error, so "the field appeared" is a change.
 */
export function jsonPath(doc: unknown, path: string): unknown {
  const p = path.trim();
  let i = p.startsWith("$") ? 1 : 0;
  let cur: unknown = doc;
  const step = (k: string | number) => {
    if (cur === null || typeof cur !== "object") cur = null;
    else cur = (cur as Record<string | number, unknown>)[k] ?? null;
  };
  while (i < p.length) {
    if (p[i] === ".") {
      const m = /^[^.[\]]+/.exec(p.slice(i + 1));
      if (!m) throw new SourceError("invalid_check", `Invalid JSON path ${path}`);
      step(m[0]);
      i += 1 + m[0].length;
    } else if (p[i] === "[") {
      const m = /^\[\s*(?:(\d+)|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*\]/.exec(p.slice(i));
      if (!m) throw new SourceError("invalid_check", `Invalid JSON path ${path}`);
      step(m[1] !== undefined ? Number(m[1]) : (m[2] ?? m[3])!.replace(/\\(.)/g, "$1"));
      i += m[0].length;
    } else if (i === 0) {
      const m = /^[^.[\]]+/.exec(p);
      step(m![0]);
      i += m![0].length;
    } else {
      throw new SourceError("invalid_check", `Invalid JSON path ${path}`);
    }
  }
  return cur;
}

/** The text of each element matching `selector`, with Bun's HTMLRewriter. */
export async function cssTexts(html: string, selector: string): Promise<string[]> {
  const out: string[] = [];
  let depth = 0;
  let rw: HTMLRewriter;
  try {
    rw = new HTMLRewriter().on(selector, {
      element(el) {
        if (depth === 0) out.push("");
        if (!el.canHaveContent) return; // a void element such as <img>: no text, no end tag
        depth++;
        el.onEndTag(() => {
          depth--;
        });
      },
      text(t) {
        if (depth > 0) out[out.length - 1] += t.text;
      },
    });
  } catch (e) {
    throw new SourceError("invalid_check", `Invalid CSS selector: ${e instanceof Error ? e.message : String(e)}`);
  }
  await rw.transform(new Response(html)).text();
  return out.map((s) => s.replace(/\s+/g, " ").trim());
}

// ---------------------------------------------------------------- file_hash

function fileHash(path: string, o: ObserveOptions): string {
  const home = o.userHome || homedir();
  const expand = (p: string) => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);
  let real: string;
  try {
    real = realpathSync(expand(path));
  } catch {
    throw new SourceError("source_missing", `${path} does not exist.`);
  }
  const inside = o.roots.some((r) => {
    let root: string;
    try {
      root = realpathSync(expand(r));
    } catch {
      return false;
    }
    const rel = relative(root, real);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
  });
  if (!inside) throw new SourceError("outside_roots", `${path} is not inside the task's folders.`);
  if (statSync(real).size > (o.maxBytes ?? SOURCE_MAX_BYTES) * 20) throw new SourceError("source_too_large", `${path} is too large to hash.`);
  return createHash("sha256").update(readFileSync(real)).digest("hex");
}
