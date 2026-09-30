import { DeviceId } from "@homerun/core";
import { type DeviceIdentity, generateDeviceKeys, identityFromStored, StoredDeviceKeys } from "@homerun/protocol";
import type { SecretStore } from "../secrets";
import type { ShellSecrets } from "../shell-secrets";

/**
 * The desktop's relay identity (§9.6 step 1, §12): an X25519 static key for Noise, an Ed25519
 * key for the relay's challenges and link statements, and the id the relay knows it by. Kept as
 * one JSON secret (`device_static_key`) that the shell stores in the Keychain or Credential
 * Manager; only the public halves ever leave the runtime.
 *
 * A new identity gets a new id, so a key lost from the Keychain never collides with the old
 * registration at the relay.
 */

const Stored = StoredDeviceKeys.extend({ device_id: DeviceId });
const NAME = "device_static_key";

export function loadIdentity(secrets: SecretStore): DeviceIdentity | null {
  const raw = secrets.get(NAME);
  if (!raw) return null;
  try {
    const s = Stored.parse(JSON.parse(raw));
    return identityFromStored(s.device_id, "desktop", s);
  } catch {
    return null;
  }
}

export function newIdentity(shellSecrets: ShellSecrets): DeviceIdentity {
  const keys = generateDeviceKeys();
  const deviceId = crypto.randomUUID() as DeviceId;
  shellSecrets.persist(NAME, JSON.stringify({ ...keys, device_id: deviceId }));
  return identityFromStored(deviceId, "desktop", keys);
}

export function forgetIdentity(secrets: SecretStore, shellSecrets: ShellSecrets): void {
  if (secrets.has(NAME)) shellSecrets.delete(NAME);
}
