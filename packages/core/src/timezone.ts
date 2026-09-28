/**
 * IANA timezone validation (§8). A name is accepted when it has IANA shape (`Area/Location`,
 * `UTC`, `Etc/GMT+5`, legacy links such as `US/Pacific`) and the host's time zone database knows
 * it. Numeric offsets like `+05:00` are rejected even where `Intl` accepts them, because a
 * schedule must follow its zone's DST rules. Different hosts carry different tzdb versions, so a
 * very new zone can be valid on one and unknown on another; clients re-check before display.
 */
export const IANA_TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

const cache = new Map<string, boolean>();

export function isValidIanaTimezone(tz: string): boolean {
  if (typeof tz !== "string" || tz.length > 64 || !IANA_TIMEZONE_PATTERN.test(tz)) return false;
  const hit = cache.get(tz);
  if (hit !== undefined) return hit;
  let ok: boolean;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    ok = true;
  } catch {
    ok = false;
  }
  cache.set(tz, ok);
  return ok;
}
