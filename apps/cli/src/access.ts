/**
 * The release CLI's credential (§5.2): connect, check who is listening, then say hello with the
 * token from the keychain, or ask the app for one and wait while the user decides.
 */
import { hostname } from "node:os";
import { RpcCallError, RpcClient, RuntimeUnavailableError } from "@homerun/client";
import { NOTIFICATIONS, RPC_ERROR, type CliAuthFailureData, type CliAccessUnavailableData } from "@homerun/core";
import { CLI_VERSION } from "./build";
import type { Target } from "./connect";
import type { Io } from "./context";
import { CliError, EXIT } from "./exit";
import type { Output } from "./output";
import { peerRefusal, verifyPeer, verifyWindowsPeer, type PeerInspector, type WindowsPeerInspector } from "./peer";
import type { TokenStore } from "./token-store";
import { Waiting } from "./waiting";

export const CLIENT = { name: "homerun-cli", version: CLI_VERSION };
export const LOGIN_HINT = "run `homerun login` to ask the Homerun app for access";

export interface AccessOptions {
  target: Target;
  store: TokenStore;
  /** The code requirement homerund must satisfy. None refuses (fails closed). */
  requirement: string | undefined;
  /** Development builds only: `--dev-skip-peer-check`. */
  skipPeerCheck: boolean;
  inspector: () => PeerInspector | Promise<PeerInspector>;
  windowsInspector: () => WindowsPeerInspector | Promise<WindowsPeerInspector>;
  platform: string;
  /** How long to wait past the runtime's own expiry before giving up on it. */
  graceMs?: number;
  now?: () => number;
}

type Decision =
  | { kind: "approved"; token: string; token_id: string }
  | { kind: "denied" | "expired" | "closed" | "interrupted" };

export class CliAccess {
  constructor(
    private io: Io,
    private o: Output,
    readonly opts: AccessOptions,
  ) {}

  get store(): TokenStore {
    return this.opts.store;
  }

  /** Connect, and check the listener before anything is read or sent. */
  async open(): Promise<RpcClient> {
    const { target } = this.opts;
    let c: RpcClient;
    try {
      c = await RpcClient.connect(target.socketPath);
    } catch (e) {
      if (e instanceof RuntimeUnavailableError) throw new CliError("Homerun is not running", EXIT.UNAVAILABLE, "open Homerun, then try again");
      throw e;
    }
    if (this.opts.skipPeerCheck) {
      this.o.note(this.o.ce.yellow("homerun: warning: --dev-skip-peer-check: not checking who is listening on the socket"));
      return c;
    }
    const { requirement, platform } = this.opts;
    const v =
      platform === "win32"
        ? await verifyWindowsPeer(target.socketPath, requirement, this.opts.windowsInspector)
        : await verifyPeer(c.fd, requirement, platform, this.opts.inspector);
    if (!v.ok) {
      c.close();
      throw peerRefusal(v.why, platform);
    }
    return c;
  }

  /**
   * An authenticated connection. With no stored token, ask for one if `mayRequest` (a terminal),
   * else refuse with 77 so a script never makes a dialog appear.
   */
  async connect(mayRequest: boolean): Promise<RpcClient> {
    const c = await this.open();
    let token: string | null;
    try {
      token = this.store.read();
    } catch (e) {
      c.close();
      throw e;
    }
    if (token) return this.hello(c, token);
    if (!mayRequest) {
      c.close();
      throw new CliError("this command-line tool isn't approved yet", EXIT.NOPERM, LOGIN_HINT);
    }
    const got = await this.request(c);
    return this.hello(c.isOpen ? c : await this.open(), got.token);
  }

  /** `homerun login`: always asks, and replaces any stored token. */
  async login(): Promise<{ c: RpcClient; token_id: string }> {
    const c = await this.open();
    const got = await this.request(c);
    return { c: await this.hello(c.isOpen ? c : await this.open(), got.token), token_id: got.token_id };
  }

  async hello(c: RpcClient, token: string): Promise<RpcClient> {
    try {
      await c.handshake("cli", { kind: "cli_token", token }, { client: CLIENT, validate: true });
      return c;
    } catch (e) {
      if (e instanceof RpcCallError && e.code === RPC_ERROR.UNAUTHENTICATED) {
        const reason = (e.data as CliAuthFailureData | undefined)?.reason;
        this.store.delete();
        throw new CliError(
          reason === "revoked" ? "this command-line tool's access was revoked in the Homerun app" : "Homerun doesn't recognise this command-line tool's token",
          EXIT.NOPERM,
          LOGIN_HINT,
        );
      }
      throw e;
    }
  }

  /** Ask for access on `c` (not yet authenticated), wait for the user, and store the token. */
  private async request(c: RpcClient): Promise<{ token: string; token_id: string }> {
    const now = this.opts.now ?? Date.now;
    const decisions: unknown[] = [];
    let wake = () => {};
    const off = c.onNotification((m, p) => {
      if (m !== "cli.access_decision") return;
      decisions.push(p);
      wake();
    });
    let req;
    try {
      req = await c.call("cli.request_access", { client: CLIENT, hostname: hostname() || "unknown" });
    } catch (e) {
      off();
      c.close();
      if (e instanceof RpcCallError && e.code === RPC_ERROR.UNAVAILABLE && (e.data as CliAccessUnavailableData | undefined)?.reason === "too_many_requests")
        throw new CliError("too many requests are waiting", EXIT.UNAVAILABLE, "answer the waiting requests in the Homerun app first");
      throw e;
    }
    const tty = !!this.io.stderr.isTTY;
    const ui = new Waiting(this.io.stderr, tty, this.o.ce, now);
    ui.start(req.expires_at);
    let offInterrupt = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const d = await new Promise<Decision>((resolve) => {
      const check = () => {
        for (const raw of decisions) {
          const p = NOTIFICATIONS["cli.access_decision"].params.safeParse(raw);
          if (!p.success || p.data.request_id !== req.request_id) continue;
          if (p.data.approved) return resolve({ kind: "approved", token: p.data.token!, token_id: p.data.token_id! });
          return resolve({ kind: p.data.reason ?? "denied" });
        }
      };
      wake = check;
      check();
      void c.closed.then(() => {
        // A decision and the close can arrive together: the decision wins.
        check();
        resolve({ kind: "closed" });
      });
      offInterrupt = this.io.onInterrupt(() => resolve({ kind: "interrupted" }));
      timer = setTimeout(() => resolve({ kind: "expired" }), Math.max(0, req.expires_at - now()) + (this.opts.graceMs ?? 10_000));
    });
    off();
    offInterrupt();
    clearTimeout(timer);
    const k = this.o.ce;
    switch (d.kind) {
      case "approved":
        try {
          this.store.write(d.token);
        } catch (e) {
          ui.finish(`${k.red("✗")} Approved, but the token could not be saved.`);
          c.close();
          throw e;
        }
        ui.finish(`${k.green("✓")} Approved. The token is saved in ${this.store.where}.`);
        return { token: d.token, token_id: d.token_id };
      case "denied":
        ui.finish(`${k.red("✗")} Denied in the Homerun app.`);
        c.close();
        throw new CliError("access was denied", EXIT.NOPERM);
      case "expired":
        ui.finish(`${k.red("✗")} No answer within 2 minutes.`);
        c.close();
        throw new CliError("the request expired", EXIT.NOPERM, LOGIN_HINT);
      case "interrupted":
        // Closing the connection withdraws the prompt.
        c.close();
        ui.finish(`${k.dim("Cancelled.")}`);
        throw new CliError("cancelled", EXIT.INTERRUPTED);
      case "closed":
        ui.finish(`${k.red("✗")} Homerun closed the connection.`);
        throw new CliError("Homerun closed the connection before an answer", EXIT.UNAVAILABLE, "is Homerun still running?");
    }
  }
}
