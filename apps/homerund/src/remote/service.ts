import type { AccountStatus } from "@homerun/core";
import { RemoteAccount, type AccountDeps } from "./account";

/**
 * Remote access as the rest of the runtime sees it (§9, §10): the account, and (from the relay
 * link on) the paired devices. It answers the `account.*` and `devices.*` methods and reports
 * changes as `account.changed` and `devices.changed`.
 */
export interface RemoteDeps extends Omit<AccountDeps, "openBrowser"> {
  /** A notification to local clients (`account.changed`) or the shell (`browser.open`). */
  broadcast: (method: "account.changed" | "browser.open", params: unknown) => void;
}

/** What tests may shorten or replace. */
export type RemoteTuning = Pick<AccountDeps, "fetch" | "signInTimeoutMs" | "handoverMs">;

export class RemoteService {
  readonly account: RemoteAccount;

  constructor(private d: RemoteDeps) {
    this.account = new RemoteAccount({ ...d, openBrowser: (url) => d.broadcast("browser.open", { url }) });
    this.account.onChange(() => this.changed());
  }

  status(): AccountStatus {
    const a = this.account.view();
    return { ...a, relay: { state: "off", since: null, error: null }, link_request: null };
  }

  signIn(): AccountStatus {
    this.account.signIn();
    return this.status();
  }

  cancelSignIn(): AccountStatus {
    this.account.cancelSignIn();
    return this.status();
  }

  async signOut(): Promise<AccountStatus> {
    await this.account.signOut();
    return this.status();
  }

  shellConnected(): void {
    this.account.shellConnected();
  }

  stop(): void {
    this.account.stop();
  }

  private changed(): void {
    this.d.broadcast("account.changed", { status: this.status() });
  }
}
