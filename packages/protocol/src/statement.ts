import { z } from "zod";
import { DeviceId, StaticPublicKey, TimestampMs } from "@homerun/core";
import { framed, fromB64url, toB64url } from "./bytes";
import { ed25519Verify, type SigningKey } from "./crypto";
import { SigningPublicKey } from "./identity";

/**
 * A link statement (§10.5, §10.7 `device_links`): the desktop's signed record that it paired with
 * a remote device. The relay routes live and sealed frames only between devices joined by a valid
 * statement, and checks it against the desktop's registered signing key. It is authorisation for
 * the relay's routing only: end-to-end security comes from the pinned Noise keys.
 */

export const LINK_STATEMENT_LABEL = "homerun/link-statement/v1";

export const RemotePlatform = z.enum(["ios", "web"]);
export type RemotePlatform = z.infer<typeof RemotePlatform>;

export const LinkStatementBody = z.strictObject({
  v: z.literal(1),
  /** The provider's subject for the account both devices are signed in to. */
  account: z.string().min(1).max(255),
  desktop_device_id: DeviceId,
  device_id: DeviceId,
  desktop_static_public_key: StaticPublicKey,
  device_static_public_key: StaticPublicKey,
  device_signing_public_key: SigningPublicKey,
  platform: RemotePlatform,
  /** How the link was made: a scanned QR code or a matching code (§9.6, §10.5). */
  method: z.enum(["qr", "code"]),
  created_at: TimestampMs,
});
export type LinkStatementBody = z.infer<typeof LinkStatementBody>;

export const LinkStatement = LinkStatementBody.extend({ signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) });
export type LinkStatement = z.infer<typeof LinkStatement>;

export function linkStatementBytes(b: LinkStatementBody): Uint8Array {
  return framed(
    LINK_STATEMENT_LABEL,
    String(b.v),
    b.account,
    b.desktop_device_id,
    b.device_id,
    b.desktop_static_public_key,
    b.device_static_public_key,
    b.device_signing_public_key,
    b.platform,
    b.method,
    String(b.created_at),
  );
}

export async function signLinkStatement(body: LinkStatementBody, desktop: SigningKey): Promise<LinkStatement> {
  const b = LinkStatementBody.parse(body);
  return { ...b, signature: toB64url(await desktop.sign(linkStatementBytes(b))) };
}

export function verifyLinkStatement(raw: unknown, desktopSigningPublicKey: string): LinkStatement | null {
  const s = LinkStatement.safeParse(raw);
  if (!s.success) return null;
  const { signature, ...body } = s.data;
  try {
    return ed25519Verify(fromB64url(signature), linkStatementBytes(body), fromB64url(desktopSigningPublicKey)) ? s.data : null;
  } catch {
    return null;
  }
}
