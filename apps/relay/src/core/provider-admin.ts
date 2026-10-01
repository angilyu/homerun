/**
 * Deleting the account's user at the identity provider (§10.9, §18 row 103). The App Store
 * requires that deleting an account in the app deletes it, sign-in included, so the relay holds
 * the provider's management key and deletes the user when the account is deleted.
 *
 * The provider stays swappable: an implementation per provider, chosen by `PROVIDER_ADMIN`.
 * `none` leaves the user to delete it in the provider's own settings, and the app says so.
 */

export interface ProviderAdmin {
  readonly name: string;
  /**
   * Deletes the user whose access tokens carry `sub`. Resolves once it's gone, including when it
   * already was; throws when it may not be, and the relay tries again later.
   */
  deleteUser(sub: string): Promise<void>;
}

export class ProviderAdminError extends Error {
  override name = "ProviderAdminError";
  constructor(readonly status: number | null) {
    super(status === null ? "the provider couldn't be reached" : `the provider answered ${status}`);
  }
}

export const WORKOS_API_BASE = "https://api.workos.com";

/** WorkOS's user management API: `DELETE /user_management/users/{id}`, the id being the token's `sub`. */
export class WorkosAdmin implements ProviderAdmin {
  readonly name = "workos";
  constructor(
    private readonly apiKey: string,
    private readonly base = WORKOS_API_BASE,
    private readonly fetchImpl: (input: string, init: RequestInit) => Promise<Response> = (i, o) => fetch(i, o),
  ) {}

  async deleteUser(sub: string): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base.replace(/\/+$/, "")}/user_management/users/${encodeURIComponent(sub)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ProviderAdminError(null);
    }
    await res.body?.cancel();
    if (res.ok || res.status === 404) return;
    throw new ProviderAdminError(res.status);
  }
}

export interface ProviderAdminConfig {
  /** `workos`, or `none` (the default): the user deletes it by hand. */
  PROVIDER_ADMIN?: string;
  WORKOS_API_KEY?: string;
  /** Tests point this at the local issuer. */
  WORKOS_API_BASE?: string;
}

/** The configured provider, or null for `none`. Throws on a configuration that can't work. */
export function providerAdminFrom(env: ProviderAdminConfig): ProviderAdmin | null {
  switch (env.PROVIDER_ADMIN || "none") {
    case "none":
      return null;
    case "workos":
      if (!env.WORKOS_API_KEY) throw new Error("PROVIDER_ADMIN=workos needs WORKOS_API_KEY");
      return new WorkosAdmin(env.WORKOS_API_KEY, env.WORKOS_API_BASE || WORKOS_API_BASE);
    default:
      throw new Error(`PROVIDER_ADMIN: unknown provider ${env.PROVIDER_ADMIN}`);
  }
}
