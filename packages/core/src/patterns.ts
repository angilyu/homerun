import { hasShellMetacharacters, isBuiltinTool } from "./tools";

// WHATWG URL, global in every consumer (Bun, browsers, Swift reads the vectors). Core compiles
// with the bare ES lib, so declare the part used here.
declare class URL {
  constructor(url: string);
  readonly protocol: string;
  readonly hostname: string;
}

/**
 * Pattern rules shared by the runtime (enforcement) and every client (the "Always allow"
 * editor previews what a pattern covers): `Bash` command patterns and egress domains (§5.5,
 * §5.6). Pure functions, no I/O.
 */

/** The `command` of a `Bash` call, or null when the input has none. */
export function bashCommandOf(input: unknown): string | null {
  const c = (input as { command?: unknown } | null | undefined)?.command;
  return typeof c === "string" ? c : null;
}

/**
 * Whole-command match of an allowlisted pattern (§5.5). `*` matches any run of characters;
 * everything else is literal. A command with shell metacharacters never matches, whatever the
 * pattern.
 */
export function bashPatternMatches(pattern: string, command: string): boolean {
  const cmd = command.trim();
  if (!cmd || hasShellMetacharacters(cmd)) return false;
  const re = new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "s");
  return re.test(cmd);
}

/** The URL of a `WebFetch` call, or null when the input has none. */
export function fetchUrlOf(input: unknown): string | null {
  const u = (input as { url?: unknown } | null | undefined)?.url;
  return typeof u === "string" ? u : null;
}

/**
 * The host a URL reaches, normalized for egress checks (§5.5): http(s) only, lowercase, IDN in
 * punycode (WHATWG URL parsing), no trailing dot. IPv6 literals keep their brackets. Null when
 * the URL does not parse or uses another scheme: such a request never matches the allowlist.
 */
export function egressHostOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  return host || null;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** An IPv4 or IPv6 literal (as `egressHostOf` returns it). */
export function isIpLiteral(host: string): boolean {
  return host.startsWith("[") || IPV4.test(host);
}

/**
 * Whether an egress allowlist entry covers a host (§5.5). `example.com` covers exactly that host;
 * `*.example.com` covers its subdomains at any depth but not `example.com` itself, so the apex is
 * listed on its own. An IP literal is covered only by the same literal, never by a wildcard.
 */
export function egressDomainMatches(domain: string, host: string): boolean {
  const d = domain.toLowerCase();
  const h = host.toLowerCase();
  if (d.startsWith("*.")) return !isIpLiteral(h) && h.endsWith(d.slice(1)) && h.length > d.length - 1;
  return d === h;
}

export function egressAllowed(domains: readonly string[], host: string): boolean {
  return domains.some((d) => egressDomainMatches(d, host));
}

/**
 * The `WebFetch` grant pattern for "Allow all web fetches for this task" (§5.6). It is a grant
 * pattern only, never an egress allowlist entry.
 */
export const ANY_DOMAIN = "*";

/**
 * Whether an all-domains `WebFetch` grant covers a host (as `egressHostOf` returns it): any host
 * name, but never an IP literal (like a `*.` wildcard, §5.5) and never `localhost` or a
 * `.localhost` name, which reach this machine rather than a website.
 */
export function anyDomainCovers(host: string): boolean {
  const h = host.toLowerCase();
  return !isIpLiteral(h) && h !== "localhost" && !h.endsWith(".localhost");
}

/**
 * Whether a grant covers a call (§5.6): the tool matches and, for
 * - `Bash`: the command matches the grant's command pattern (never with shell metacharacters);
 * - `WebFetch`: the URL's host matches the grant's domain, or any host name for `*`
 *   (`ANY_DOMAIN`); never a URL that isn't http(s);
 * - a third-party MCP tool: a grant without a pattern covers every call ("Trust this tool").
 * Grants on other built-ins, and MCP grants with a pattern, cover nothing yet.
 */
export function grantCovers(grant: { tool: string; pattern: string | null }, call: { tool: string; input: unknown }): boolean {
  if (grant.tool !== call.tool) return false;
  if (call.tool === "Bash") {
    const cmd = bashCommandOf(call.input);
    return grant.pattern !== null && cmd !== null && bashPatternMatches(grant.pattern, cmd);
  }
  if (call.tool === "WebFetch") {
    const url = fetchUrlOf(call.input);
    const host = url ? egressHostOf(url) : null;
    if (grant.pattern === null || host === null) return false;
    return grant.pattern === ANY_DOMAIN ? anyDomainCovers(host) : egressDomainMatches(grant.pattern, host);
  }
  if (isBuiltinTool(call.tool)) return false;
  return grant.pattern === null;
}
