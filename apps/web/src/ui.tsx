import { createContext, useContext, type ReactNode } from "react";
import { seenText } from "@homerun/app-state";
import { useAction, useNow, useStore } from "@homerun/desktop/hooks";
import { AppRoot } from "@homerun/desktop/app";
import { Badge, ConfirmButton, Empty, ErrorText } from "@homerun/desktop/ui";
import type { App } from "@homerun/desktop/hooks";
import type { WebSession, Phase } from "./session";

/**
 * The web client's own screens (§9.9): the front door (sign in, link this browser by code,
 * choose a desktop) and its section of Settings. Everything else is the desktop's views.
 */

export type Session = WebSession<App>;

const SessionContext = createContext<Session | null>(null);

function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside WebRoot");
  return s;
}

export function WebRoot({ session }: { session: Session }) {
  const phase = useStore(session.phase);
  return <SessionContext.Provider value={session}>{phase.s === "ready" ? <AppRoot app={phase.app} /> : <FrontDoor phase={phase} />}</SessionContext.Provider>;
}

function Door({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="center">
      <div className="card narrow onboarding front-door">
        <p className="brand">Homerun</p>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

function FrontDoor({ phase }: { phase: Exclude<Phase<App>, { s: "ready" }> }) {
  const session = useSession();
  const act = useAction(async (fn: () => Promise<void>) => fn());
  switch (phase.s) {
    case "starting":
    case "connecting":
    case "redirecting":
      return (
        <Door title="Homerun">
          <p className="muted" role="status">
            {phase.s === "redirecting" ? "Opening sign-in…" : "Connecting…"}
          </p>
        </Door>
      );
    case "unsupported":
      return (
        <Door title="This browser can’t run Homerun">
          <p>Homerun keeps this browser’s keys where pages can’t read them out, which needs a current Chrome, Edge, Safari or Firefox, with site data allowed.</p>
        </Door>
      );
    case "elsewhere":
      return (
        <Door title="Homerun is open in another tab">
          <p>Use it there, or use it here instead.</p>
          <div className="row">
            <button type="button" className="primary" onClick={() => void session.useHere()}>
              Use here
            </button>
          </div>
        </Door>
      );
    case "signed_out":
      return (
        <Door title="Homerun on the web">
          {phase.notice && (
            <p className={`notice ${phase.tone}`} role="status">
              {phase.notice}
            </p>
          )}
          <p>Chat with the agents on your Mac from this browser. Approvals, and anything that changes a task, stay on your phone or Mac.</p>
          <div className="row">
            <button type="button" className="primary" onClick={() => void session.signIn()}>
              Sign in
            </button>
          </div>
        </Door>
      );
    case "pick":
      return (
        <Door title="Choose a computer">
          <Desktops />
        </Door>
      );
    case "link":
      return <Link phase={phase} />;
    case "error":
      return (
        <Door title="Homerun can’t connect">
          <ErrorText error={phase.message} />
          <div className="row">
            <button type="button" className="primary" onClick={() => session.retry()}>
              Try again
            </button>
            <button type="button" disabled={act.busy} onClick={() => void act.run(() => session.signOut())}>
              Sign out
            </button>
          </div>
        </Door>
      );
  }
}

function Link({ phase }: { phase: Extract<Phase<App>, { s: "link" }> }) {
  const session = useSession();
  const linked = useStore(session.desktops);
  const step = phase.step;
  const back = linked.length > 0 && (
    <button type="button" onClick={() => session.back()}>
      Back
    </button>
  );
  if (step.k === "linking") {
    return (
      <Door title={`Link with ${step.name}`}>
        {step.code === null ? (
          <p className="muted" role="status">
            Asking {step.name}…
          </p>
        ) : (
          <>
            <p>Check that {step.name} shows this code, then choose Link there.</p>
            <p className="link-code" aria-label="Link code">
              {step.code.slice(0, 3)} {step.code.slice(3)}
            </p>
          </>
        )}
        <div className="row">
          <button type="button" onClick={() => session.cancelLink()}>
            Cancel
          </button>
        </div>
      </Door>
    );
  }
  if (step.k === "declined") {
    return (
      <Door title="Not linked">
        <p className="notice warn" role="status">
          The link was declined on {step.name}.
        </p>
        <div className="row">
          <button type="button" className="primary" onClick={() => void session.linkAnother()}>
            Try again
          </button>
          {back}
        </div>
      </Door>
    );
  }
  return (
    <Door title="Link this browser">
      {phase.notice && (
        <p className="notice warn" role="status">
          {phase.notice}
        </p>
      )}
      <p>Choose your computer. It shows a code; check it matches the one here, then confirm on the computer.</p>
      {phase.desktops === null ? (
        <p className="muted" role="status">
          Looking for your computers…
        </p>
      ) : phase.desktops.length === 0 ? (
        <Empty>No computer in your account is signed in. On your Mac, sign in under Settings → Remote access, then try again.</Empty>
      ) : (
        <ul className="plain" aria-label="Your computers">
          {phase.desktops.map((d) => (
            <li key={d.device_id}>
              <button type="button" className="row-card" onClick={() => void session.link(d)}>
                <strong>{d.name}</strong>
                <span className="muted small">{d.online ? "Online" : "Offline: it must be online to link"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorText error={step.error} />
      <div className="row">
        {phase.desktops !== null && (
          <button type="button" onClick={() => void session.linkAnother()}>
            Refresh
          </button>
        )}
        {back}
        <ConfirmButton label="Sign out" confirm="Sign out of Homerun in this browser?" onConfirm={() => void session.signOut()} />
      </div>
    </Door>
  );
}

/** The desktops this browser is linked with: open one, unlink one, link another. */
function Desktops({ current }: { current?: string }) {
  const session = useSession();
  const desktops = useStore(session.desktops);
  const now = useNow();
  const unlink = useAction((id: string) => session.unlink(id));
  return (
    <div role="group" aria-label="Computers">
      <ul className="plain">
        {desktops.map((d) => (
          <li key={d.device_id}>
            {d.name} <span className="muted">{seenText(d, now)}</span>{" "}
            {d.device_id === current ? (
              <Badge tone="info">Open</Badge>
            ) : (
              <button type="button" onClick={() => session.show(d.device_id)}>
                Open
              </button>
            )}{" "}
            <ConfirmButton label="Unlink" confirm="Unlink it? This browser can’t reach it until you link it again." onConfirm={() => void unlink.run(d.device_id)} />
          </li>
        ))}
      </ul>
      <ErrorText error={unlink.error} />
      <div className="row">
        <button type="button" onClick={() => void session.linkAnother()}>
          Link another computer
        </button>
      </div>
    </div>
  );
}

/** Settings → This browser: the account, the linked desktops, sign out and delete the account. */
export function WebSettings() {
  const session = useSession();
  const phase = useStore(session.phase);
  const act = useAction(async (fn: () => Promise<void>) => fn());
  return (
    <section aria-label="This browser">
      <h2>This browser</h2>
      <p>
        Signed in{session.email ? <> as {session.email}</> : null}. <Badge>Web browser</Badge>
      </p>
      <p className="muted small">A browser can chat and answer questions. Approve actions, and create or change tasks, on your phone or Mac.</p>
      <h3>Computers</h3>
      <Desktops {...(phase.s === "ready" ? { current: phase.desktopId } : {})} />
      <div className="row">
        <ConfirmButton label="Sign out" confirm="Sign out? This browser stays linked, and reconnects when you sign in again." onConfirm={() => void act.run(() => session.signOut())} />
        <ConfirmButton
          label="Delete account"
          danger
          confirm="Delete your account? Every phone and browser is unlinked, queued messages are deleted, and so is your sign-in. Chats on your computers stay."
          onConfirm={() => void act.run(() => session.deleteAccount())}
        />
      </div>
      <ErrorText error={act.error} />
    </section>
  );
}
