import { useEffect, useMemo } from "react";
import { deletedText, platformName, relayText, seenText, type PairingOffer } from "@homerun/app-state";
import type { AccountStatus, PairedDevice } from "@homerun/core";
import { encode } from "uqr";
import { useAction, useApp, useNow, useStore } from "../hooks";
import { Badge, ConfirmButton, Empty, ErrorText, Time } from "../ui/bits";

/**
 * Settings → Remote access (§10): sign in, the relay link, pairing a phone by QR (§9.6) and the
 * devices linked to this computer. A device linking by code is confirmed in the shell's native
 * prompt, never here (§10.5): this only says one is waiting.
 */
export function RemoteSection() {
  const app = useApp();
  const remote = app.client.remote;
  const account = useStore(remote.account);
  const devices = useStore(remote.devices);
  const loadError = useStore(remote.error);
  const pairing = useStore(remote.pairing);
  const act = useAction(async (f: () => Promise<unknown>) => void (await f()));
  useEffect(() => () => void remote.closePairing(), [remote]);
  if (!account) {
    return (
      <section aria-label="Remote access">
        <h2>Remote access</h2>
        <ErrorText error={loadError} />
      </section>
    );
  }
  return (
    <section aria-label="Remote access">
      <h2>Remote access</h2>
      <AccountPart account={account} run={(f) => void act.run(f)} busy={act.busy} hasDevices={(devices?.length ?? 0) > 0} />
      <ErrorText error={act.error} />
      {account.link_request && (
        <p className="notice info" role="status">
          {account.link_request.platform === "ios" ? "An iPhone" : "A web browser"} called “{account.link_request.name}” is asking to link. Compare the code in the
          Homerun dialog with the one it shows.
        </p>
      )}
      {pairing && <PairingPanel offer={pairing} />}
      {account.state === "signed_in" && !pairing && (
        <div className="row">
          <button type="button" className="primary" disabled={act.busy} onClick={() => void act.run(() => remote.startPairing())}>
            Pair a phone
          </button>
        </div>
      )}
      {account.state !== "not_configured" && <Devices devices={devices} />}
    </section>
  );
}

function AccountPart({ account, run, busy, hasDevices }: { account: AccountStatus; run: (f: () => Promise<unknown>) => void; busy: boolean; hasDevices: boolean }) {
  const remote = useApp().client.remote;
  const deleted = useStore(remote.deleted);
  const now = useNow();
  const signIn = (
    <button type="button" className="primary" disabled={busy} onClick={() => run(remote.signIn)}>
      Sign in
    </button>
  );
  switch (account.state) {
    case "not_configured":
      return <p className="muted">This build of Homerun isn’t set up for remote access.</p>;
    case "signed_out":
      return (
        <>
          {deleted && (
            <p className={deleted === "deleted" ? "notice info" : "notice warn"} role="status">
              {deletedText(deleted)}
            </p>
          )}
          <p>Sign in to use Homerun from your iPhone or a browser. Chats stay on this computer; the relay only passes on encrypted messages.</p>
          {hasDevices && <p className="muted small">Your paired devices stay paired, and reconnect when you sign in to the same account.</p>}
          <ErrorText error={account.error} />
          <div className="row">{signIn}</div>
        </>
      );
    case "signing_in":
      return (
        <>
          <p role="status">Continue in your browser…</p>
          <div className="row">
            <button type="button" onClick={() => run(remote.cancelSignIn)}>
              Cancel
            </button>
          </div>
        </>
      );
    case "needs_sign_in":
      return (
        <>
          <p className="notice warn">Sign in again to keep using Homerun from your phone.</p>
          <ErrorText error={account.error} />
          <div className="row">{signIn}</div>
        </>
      );
    case "signed_in":
      return (
        <>
          <p>
            Signed in{account.email ? <> as {account.email}</> : null}. <span className="muted">Relay:</span> <span data-relay={account.relay.state}>{relayText(account, now)}</span>
          </p>
          {account.relay.state !== "connected" && account.relay.error && <p className="muted small">{account.relay.error}</p>}
          <div className="row">
            <ConfirmButton label="Sign out" confirm="Sign out? Your phone can’t reach this computer until you sign in again." onConfirm={() => run(remote.signOut)} />
            <ConfirmButton
              label="Delete account"
              danger
              confirm="Delete your account? Every paired device is unpaired and queued messages are deleted. Chats on this computer stay."
              onConfirm={() => run(remote.deleteAccount)}
            />
          </div>
        </>
      );
  }
}

function Devices({ devices }: { devices: readonly PairedDevice[] | null }) {
  const remote = useApp().client.remote;
  const now = useNow();
  const unpair = useAction((id: string) => remote.unpair(id));
  if (!devices) return null;
  return (
    <div role="group" aria-label="Paired devices">
      <h3>Paired devices</h3>
      {devices.length === 0 && <Empty>No phones or browsers are paired.</Empty>}
      <ul className="plain">
        {devices.map((d) => (
          <li key={d.device_id}>
            {d.name} <Badge>{platformName(d.platform)}</Badge>{" "}
            <span className="muted">
              paired <Time ts={d.paired_at} /> · {seenText(d, now)}
            </span>{" "}
            <ConfirmButton label="Unpair" confirm="Unpair it? It can’t reach this computer again until you pair it again." onConfirm={() => void unpair.run(d.device_id)} />
          </li>
        ))}
      </ul>
      <ErrorText error={unpair.error} />
    </div>
  );
}

/** The QR offer (§9.6): a one-time secret, shown only here, gone when a phone uses it or in 5 min. */
function PairingPanel({ offer }: { offer: PairingOffer }) {
  const remote = useApp().client.remote;
  const now = useNow(1000);
  const again = useAction(() => remote.startPairing());
  const left = Math.max(0, offer.expires_at - now);
  if (offer.paired) {
    return (
      <div className="notice" role="dialog" aria-label="Pair a phone">
        <p role="status">Paired with {offer.paired.name}.</p>
        <button type="button" className="primary" onClick={() => void remote.closePairing()}>
          Done
        </button>
      </div>
    );
  }
  return (
    <div className="notice pairing" role="dialog" aria-label="Pair a phone">
      {left > 0 ? (
        <>
          <Qr text={offer.qr_url} />
          <p>Scan this with the Homerun app on your iPhone. Don’t share it: it lets one phone pair with this computer.</p>
          <p className="muted small" role="timer">
            Expires in {Math.floor(left / 60_000)}:{String(Math.floor((left % 60_000) / 1000)).padStart(2, "0")}
          </p>
        </>
      ) : (
        <>
          <p>This code expired.</p>
          <button type="button" disabled={again.busy} onClick={() => void again.run()}>
            New code
          </button>
        </>
      )}
      <ErrorText error={again.error} />
      <div className="row">
        <button type="button" onClick={() => void remote.closePairing()}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** A QR code drawn from its modules: no generated markup goes into the page. */
export function Qr({ text }: { text: string }) {
  const { size, d } = useMemo(() => {
    const q = encode(text, { ecc: "M", border: 2 });
    let d = "";
    q.data.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)));
    return { size: q.size, d };
  }, [text]);
  return (
    <svg className="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Pairing QR code" shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
