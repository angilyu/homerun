import type { DeviceId } from "@homerun/core";
import type { DeviceKind, LinkStatement, StoredDeviceKeys } from "@homerun/protocol";

/**
 * What a remote client keeps between runs: its device identity, the desktops it is paired with
 * (their pinned keys and the statements that link them), and the ids of sealed messages it has
 * already opened. Behind an interface: memory here, the Keychain and a database on iOS, IndexedDB
 * with non-extractable keys on the web (milestone 10).
 */

export interface PairedDesktop {
  device_id: DeviceId;
  name: string;
  static_public_key: string;
  signing_public_key: string;
  statement: LinkStatement;
}

export interface RemoteState {
  device: { device_id: DeviceId; kind: DeviceKind; name: string; keys: StoredDeviceKeys };
  desktops: Record<string, PairedDesktop>;
  /** Sealed message ids already opened, until when to remember them. */
  seen: Record<string, number>;
}

export interface RemoteStore {
  load(): Promise<RemoteState | null>;
  save(state: RemoteState): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryStore implements RemoteStore {
  private state: RemoteState | null = null;
  async load() {
    return this.state ? structuredClone(this.state) : null;
  }
  async save(state: RemoteState) {
    this.state = structuredClone(state);
  }
  async clear() {
    this.state = null;
  }
}
