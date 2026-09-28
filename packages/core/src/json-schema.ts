import { z } from "zod";
import { namedSchemas } from "./registry";
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOL, CAPABILITIES } from "./protocol/handshake";
import { METHODS, METHOD_NAMES, NOTIFICATIONS, NOTIFICATION_NAMES, methodSchemaIds, notificationSchemaId } from "./protocol/methods";
import { ALLOWLISTS, PREAUTH_METHODS, RUNTIME_TO_SHELL_METHODS, SHELL_ONLY_METHODS, NOTIFICATIONS_BY_DIRECTION } from "./protocol/callers";
import { LIVE_ONLY_EVENT_TYPES, PERSISTED_EVENT_TYPES } from "./events";
import { RPC_ERROR } from "./protocol/jsonrpc";
import { SPEC_FORMAT } from "./task-spec";
import { RELAY_ENVELOPE_VERSION } from "./relay";

export const SCHEMA_BUNDLE_ID = "https://homerun.dev/schema/homerun.schema.json";

/**
 * One JSON Schema (draft 2020-12) document holding every named schema under `$defs`. Refer to
 * one as `homerun.schema.json#/$defs/<Name>`.
 *
 * JSON Schema cannot express the refinements (cron grammar, IANA zone validity, cross-field
 * rules). Those are listed in the README; other-language clients implement them by hand and
 * check themselves against the golden vectors.
 */
export function buildSchemaBundle(): Record<string, unknown> {
  const all = [...namedSchemas().entries()].sort(([a], [b]) => a.localeCompare(b));
  const root = z.object(Object.fromEntries(all));
  const out = z.toJSONSchema(root, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "throw",
    reused: "inline",
    cycles: "ref",
  }) as Record<string, unknown>;
  let defs = (out.$defs ?? {}) as Record<string, Record<string, unknown>>;
  for (const d of Object.values(defs)) delete d.id;
  // Zod names recursive helpers `__schemaN`. Fold each into the named def that is only a ref to it.
  for (const anon of Object.keys(defs).filter((k) => k.startsWith("__schema"))) {
    const owner = Object.keys(defs).find((k) => !k.startsWith("__") && defs[k]!.$ref === `#/$defs/${anon}` && Object.keys(defs[k]!).length === 1);
    if (!owner) throw new Error(`unnamed recursive schema ${anon}`);
    const { [anon]: body, ...rest } = defs;
    rest[owner] = body!;
    defs = JSON.parse(JSON.stringify(rest).replaceAll(`"#/$defs/${anon}"`, `"#/$defs/${owner}"`));
  }
  const sortedDefs = Object.fromEntries(Object.entries(defs).sort(([a], [b]) => a.localeCompare(b)));
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: SCHEMA_BUNDLE_ID,
    title: "Homerun core schemas",
    description: `Generated from packages/core by scripts/gen.ts. Protocol v${PROTOCOL_VERSION}, spec format ${SPEC_FORMAT}. Do not edit.`,
    $defs: sortedDefs,
  };
}

/** Allowlists per caller role, for the Rust shell and remote clients. */
export function buildCallers(): Record<string, unknown> {
  return {
    protocol: PROTOCOL_VERSION,
    allowlists: ALLOWLISTS,
    shell_only: SHELL_ONLY_METHODS,
    preauth: PREAUTH_METHODS,
    runtime_to_shell: RUNTIME_TO_SHELL_METHODS,
    notifications: NOTIFICATIONS_BY_DIRECTION,
  };
}

/** Machine-readable index: versions, event types, and each method's schema names. */
export function buildManifest(): Record<string, unknown> {
  return {
    protocol: { version: PROTOCOL_VERSION, supported: SUPPORTED_PROTOCOL, capabilities: CAPABILITIES },
    spec_format: SPEC_FORMAT,
    relay_envelope: RELAY_ENVELOPE_VERSION,
    events: { persisted: PERSISTED_EVENT_TYPES, live_only: LIVE_ONLY_EVENT_TYPES },
    errors: RPC_ERROR,
    methods: Object.fromEntries(
      METHOD_NAMES.map((m) => [
        m,
        {
          direction: METHODS[m].direction,
          preauth: METHODS[m].preauth,
          callers: METHODS[m].callers,
          ...methodSchemaIds(m),
          description: METHODS[m].description,
        },
      ]),
    ),
    notifications: Object.fromEntries(
      NOTIFICATION_NAMES.map((n) => [
        n,
        {
          direction: NOTIFICATIONS[n].direction,
          recipients: NOTIFICATIONS[n].recipients,
          params: notificationSchemaId(n),
          description: NOTIFICATIONS[n].description,
        },
      ]),
    ),
  };
}
