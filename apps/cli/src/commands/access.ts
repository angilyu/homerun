import type { CliAccess } from "../access";
import { CliError, EXIT } from "../exit";
import type { Output } from "../output";

/** `homerun login`: ask the app for access, and replace any stored token. */
export async function login(a: CliAccess, o: Output): Promise<number> {
  const { c, token_id } = await a.login();
  c.close();
  if (o.json) o.value({ approved: true, token_id, stored_in: a.store.where });
  return EXIT.OK;
}

/** `homerun logout`: revoke this tool's token in the app, then forget it. */
export async function logout(a: CliAccess, o: Output): Promise<number> {
  const done = (signedOut: boolean, revoked: boolean, note: string) => {
    if (o.json) o.value({ signed_out: signedOut, revoked });
    else o.note(note);
    return EXIT.OK;
  };
  let c;
  try {
    // The peer check comes first, as for every use of the token.
    c = await a.open();
  } catch (e) {
    if (!(e instanceof CliError) || e.code !== EXIT.UNAVAILABLE) throw e;
    if (!a.store.delete()) return done(false, false, "Not signed in.");
    return done(true, false, `Removed the token from ${a.store.where}. Homerun isn't running, so it is still listed in its Settings; revoke it there.`);
  }
  let token: string | null;
  try {
    token = a.store.read();
  } catch (e) {
    c.close();
    throw e;
  }
  if (!token) {
    c.close();
    return done(false, false, "Not signed in.");
  }
  try {
    await a.hello(c, token);
  } catch (e) {
    // Unknown or revoked: hello() has already removed it, and there is nothing to revoke.
    if (e instanceof CliError && e.code === EXIT.NOPERM) return done(true, false, `Signed out. The token was already revoked; it is removed from ${a.store.where}.`);
    throw e;
  }
  try {
    await c.call("cli.sign_out", {});
  } finally {
    c.close();
  }
  a.store.delete();
  return done(true, true, `Signed out. The token is revoked and removed from ${a.store.where}.`);
}
