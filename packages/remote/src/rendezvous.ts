import type { DeviceId } from "@homerun/core";
import { fromB64url, toB64url } from "@homerun/protocol";
import type { RelayConnection } from "./relay-connection";

/**
 * One pairing or linking conversation through the relay: a queue of the peer's messages in
 * this session, and a way to send ours. The relay only forwards; Noise authenticates.
 */
export class RendezvousChannel {
  private inbox: Uint8Array[] = [];
  private waiter: { resolve: (b: Uint8Array) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;
  private off: () => void;

  constructor(
    private readonly conn: RelayConnection,
    readonly kind: "pair" | "link",
    readonly peer: DeviceId,
    readonly session: string,
    private readonly offer?: string,
  ) {
    const offs = [
      conn.onFrame((f) => {
        if (f.type === "rendezvous" && f.from === peer && f.session === session && f.kind === kind) this.push(fromB64url(f.data));
        else if (f.type === "rendezvous_close" && f.from === peer && f.session === session) this.fail(new RendezvousError("closed", "the desktop ended the attempt"));
        else if (f.type === "error" && f.ref === session) this.fail(new RendezvousError(f.code, f.message));
      }),
      conn.onState((s) => {
        if (s !== "ready") this.fail(new RendezvousError("disconnected", "lost the relay connection"));
      }),
    ];
    this.off = () => offs.forEach((o) => o());
  }

  private first = true;

  send(data: Uint8Array): void {
    if (this.failure) throw this.failure;
    const f = { type: "rendezvous", kind: this.kind, to: this.peer, session: this.session, data: toB64url(data) } as const;
    const ok = this.conn.send(this.first && this.offer ? { ...f, offer: this.offer } : f);
    this.first = false;
    if (!ok) throw new RendezvousError("disconnected", "not connected to the relay");
  }

  next(timeoutMs = 30_000): Promise<Uint8Array> {
    if (this.failure) return Promise.reject(this.failure);
    const queued = this.inbox.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiter = null;
        reject(new RendezvousError("timeout", "the desktop didn't answer in time"));
      }, timeoutMs);
      this.waiter = {
        resolve: (b) => (clearTimeout(t), resolve(b)),
        reject: (e) => (clearTimeout(t), reject(e)),
      };
    });
  }

  close(notify = true): void {
    if (notify && !this.failure) this.conn.send({ type: "rendezvous_close", to: this.peer, session: this.session });
    this.fail(new RendezvousError("closed", "closed"));
    this.off();
  }

  private push(b: Uint8Array): void {
    const w = this.waiter;
    this.waiter = null;
    if (w) w.resolve(b);
    else this.inbox.push(b);
  }

  private fail(e: Error): void {
    if (this.failure) return;
    this.failure = e;
    const w = this.waiter;
    this.waiter = null;
    w?.reject(e);
  }
}

export class RendezvousError extends Error {
  override name = "RendezvousError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
