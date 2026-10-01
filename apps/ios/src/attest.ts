import type { ApprovalProof } from "@homerun/core";
import { Store, type ApprovalSigner, type Transport } from "@homerun/app-state";
import type { AppAttestation, AttestedIdentity } from "@homerun/protocol";
import { nativeCode, type HomerunNative } from "./native";

/**
 * App Attest and the Face ID approval key (§9.8, §18 rows 84, 115).
 *
 * The phone attests its device keys and its Secure Enclave approval key; each desktop verifies the
 * attestation itself and pins the App Attest key and the approval key. An attestation the relay
 * sees at registration is advisory, so it is made once and reused. Pairing and linking use one no
 * desktop has pinned yet (a key attests once), and this phone remembers which App Attest key and
 * approval key each desktop pinned. When Face ID enrolment changes, the approval key stops
 * working: the phone makes a new one and renews it with each desktop by an App Attest assertion
 * from the key that desktop pinned, before it next signs for that desktop.
 */

interface Cached {
  device_id: string;
  approval_key: string | null;
  attestation: AppAttestation;
  /** A desktop pinned this one's App Attest key: pairing needs a new one. */
  pinned: boolean;
}

/** What a desktop pinned for this phone. */
export interface PinnedAttestation {
  key_id: string;
  approval_key: string | null;
}

const CACHED = "attestation";
const pinnedName = (desktopId: string) => `desktop.${desktopId}`;

export class Attester {
  private purpose: "register" | "pair" = "register";
  private last: Cached | null = null;
  /** Something the person should know about Face ID approvals; shown once by the views. */
  readonly notice = new Store<string | null>(null);

  constructor(private readonly native: HomerunNative) {}

  get supported(): boolean {
    return this.native.appAttestSupported;
  }

  /** `RemoteClient`'s `attest` option: undefined where there's no App Attest, or it failed (the phone then links as a browser). */
  readonly attest = async (id: AttestedIdentity): Promise<AppAttestation | undefined> => {
    if (!this.native.appAttestSupported) return undefined;
    try {
      const approvalKey = (await this.native.approvalKeyPublic()) ?? (await this.native.approvalKeyCreate());
      const cached = await this.cached();
      if (cached && cached.device_id === id.device_id && cached.approval_key === approvalKey && (this.purpose === "register" || !cached.pinned)) {
        this.last = cached;
        return cached.attestation;
      }
      const raw = await this.native.attest(id.device_id, id.static_public_key, id.signing_public_key, approvalKey);
      if (!raw) return undefined;
      const fresh: Cached = { device_id: id.device_id, approval_key: approvalKey, attestation: JSON.parse(raw) as AppAttestation, pinned: false };
      await this.native.kvSet(CACHED, JSON.stringify(fresh));
      this.last = fresh;
      return fresh.attestation;
    } catch {
      return undefined;
    }
  };

  /** Pairs or links with `f`, then remembers what the desktop pinned. */
  async pairing<T>(desktopId: () => string | null, f: () => Promise<T>): Promise<T> {
    this.purpose = "pair";
    this.last = null;
    try {
      const r = await f();
      const used = this.last as Cached | null;
      const id = desktopId();
      if (used && id) {
        await this.native.kvSet(pinnedName(id), JSON.stringify({ key_id: used.attestation.key_id, approval_key: used.approval_key } satisfies PinnedAttestation));
        await this.native.kvSet(CACHED, JSON.stringify({ ...used, pinned: true }));
      }
      return r;
    } finally {
      this.purpose = "register";
    }
  }

  async pinned(desktopId: string): Promise<PinnedAttestation | null> {
    const raw = await this.native.kvGet(pinnedName(desktopId));
    return raw ? (JSON.parse(raw) as PinnedAttestation) : null;
  }

  /** Forgets a desktop's pins (after unpairing). */
  forget(desktopId: string): Promise<void> {
    return this.native.kvSet(pinnedName(desktopId), null);
  }

  /**
   * The approval signer for one desktop, or undefined where it can't take this phone's destructive
   * approvals (it linked the phone as a browser, or no approval key was attested): the views then
   * say "Approve on your Mac".
   */
  async signerFor(desktopId: string, deviceId: string, transport: Transport, role: string | null): Promise<ApprovalSigner | undefined> {
    if (role !== "ios") return undefined;
    const pin = await this.pinned(desktopId);
    if (!pin?.approval_key) return undefined;
    return async (a): Promise<ApprovalProof | null> => {
      await this.renewIfNeeded(desktopId, deviceId, transport);
      try {
        const signature = await this.native.approvalSign(deviceId, desktopId, a.request_id, a.decision, a.expires_at, "Approve this action");
        return signature ? { signature, expires_at: a.expires_at } : null;
      } catch (e) {
        if (nativeCode(e) !== "APPROVAL_KEY_UNUSABLE") throw e;
        // Face ID enrolment changed: a new key, renewed with this desktop, then the person tries again.
        await this.native.approvalKeyCreate();
        const renewed = await this.renewIfNeeded(desktopId, deviceId, transport).catch(() => false);
        this.notice.set(
          renewed
            ? "Face ID changed on this iPhone, so it made a new approval key. Your Mac accepted it: approve again."
            : "Face ID changed on this iPhone and your Mac didn’t accept its new approval key. Approve on your Mac.",
        );
        return null;
      }
    };
  }

  /** Renews this desktop's pinned approval key if the phone's is different; true if they now match. */
  private async renewIfNeeded(desktopId: string, deviceId: string, transport: Transport): Promise<boolean> {
    const pin = await this.pinned(desktopId);
    const current = await this.native.approvalKeyPublic();
    if (!pin || !current) return false;
    if (pin.approval_key === current) return true;
    const assertion = await this.native.assertRenewal(pin.key_id, deviceId, current);
    if (!assertion) return false;
    await transport.call("devices.renew_approval_key", { approval_key: current, assertion });
    await this.native.kvSet(pinnedName(desktopId), JSON.stringify({ ...pin, approval_key: current } satisfies PinnedAttestation));
    return true;
  }

  private async cached(): Promise<Cached | null> {
    const raw = await this.native.kvGet(CACHED);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Cached;
    } catch {
      return null;
    }
  }
}
