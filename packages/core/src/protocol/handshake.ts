import { z } from "zod";
import { named } from "../registry";
import { DeviceId } from "../common";

/**
 * Handshake (§5.2): the first request on every connection is `hello`. Both sides send the range
 * of protocol versions they speak; the runtime picks the highest in common, or fails with
 * INCOMPATIBLE_PROTOCOL so the UI can fall back to its bundled baseline (§14).
 *
 * The protocol version changes only for breaking changes (a removed or retyped field, a
 * changed meaning). Additions are announced through capabilities instead: a side uses a
 * feature only if both listed it.
 */
export const PROTOCOL_VERSION = 1 as const;
export const SUPPORTED_PROTOCOL = { min: 1, max: PROTOCOL_VERSION } as const;

/** Protocol v1 has no optional features yet; the baseline is everything in the method table. */
export const CAPABILITIES = [] as const satisfies readonly string[];

export const Capability = named("Capability", z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/));

export const ProtocolRange = named(
  "ProtocolRange",
  z.object({ min: z.int().min(1), max: z.int().min(1) }).refine((r) => r.min <= r.max, "min must not exceed max"),
);
export type ProtocolRange = z.infer<typeof ProtocolRange>;

/**
 * Who is on the other end. The runtime derives the role from the credentials, never from the
 * claim alone: the launch token proves `shell`, a CLI token proves `cli`, and a paired device's
 * E2E session proves `ios` or `web` (§9.4). Forwarded webview calls ride the shell's connection
 * and are tagged `webview` by the shell (§5.2).
 */
export const CallerRole = named("CallerRole", z.enum(["shell", "webview", "cli", "ios", "web"]));
export type CallerRole = z.infer<typeof CallerRole>;
export const CALLER_ROLES = CallerRole.options;

const Hex256 = z.string().regex(/^[0-9a-f]{64}$/);
/** CLI tokens are 256-bit random, base64url without padding. */
export const CliToken = named("CliToken", z.string().regex(/^[A-Za-z0-9_-]{43}$/));

export const HelloAuth = named(
  "HelloAuth",
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("launch_token"), token: Hex256 }),
    z.object({ kind: z.literal("cli_token"), token: CliToken }),
    /** Remote clients: the E2E session already authenticated the device; this names it. */
    z.object({ kind: z.literal("paired_device"), device_id: DeviceId }),
  ]),
);
export type HelloAuth = z.infer<typeof HelloAuth>;

export const ClientInfo = named(
  "ClientInfo",
  z.object({ name: z.string().min(1).max(100), version: z.string().min(1).max(100) }),
);

export const HelloParams = named(
  "HelloParams",
  z
    .object({
      protocol: ProtocolRange,
      role: CallerRole,
      auth: HelloAuth,
      client: ClientInfo,
      capabilities: z.array(Capability).max(256),
    })
    .superRefine((p, ctx) => {
      const ok =
        (p.auth.kind === "launch_token" && (p.role === "shell" || p.role === "webview")) ||
        (p.auth.kind === "cli_token" && p.role === "cli") ||
        (p.auth.kind === "paired_device" && (p.role === "ios" || p.role === "web"));
      if (!ok) ctx.addIssue({ code: "custom", path: ["auth"], message: `${p.auth.kind} cannot authenticate role ${p.role}` });
    }),
);
export type HelloParams = z.infer<typeof HelloParams>;

export const HelloResult = named(
  "HelloResult",
  z.object({
    /** The version both sides now speak. */
    protocol: z.int().min(1),
    runtime_version: z.string().min(1).max(100),
    device_id: DeviceId,
    role: CallerRole,
    /** Capabilities both sides support. */
    capabilities: z.array(Capability).max(256),
  }),
);
export type HelloResult = z.infer<typeof HelloResult>;

/** Highest version in both ranges, or null if they do not overlap. */
export function negotiateProtocol(ours: ProtocolRange, theirs: ProtocolRange): number | null {
  const v = Math.min(ours.max, theirs.max);
  return v >= Math.max(ours.min, theirs.min) ? v : null;
}

export function negotiateCapabilities(ours: readonly string[], theirs: readonly string[]): string[] {
  const t = new Set(theirs);
  return [...new Set(ours)].filter((c) => t.has(c)).sort();
}
