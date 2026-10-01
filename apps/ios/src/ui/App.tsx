import { useEffect, useState } from "react";
import { AppState, Pressable, Settings as Defaults, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import Constants from "expo-constants";
import { authenticateAsync } from "expo-local-authentication";
import { AppClient, seenText } from "@homerun/app-state";
import { Homerun } from "../../modules/homerun";
import { HistoryCache } from "../cache";
import { parseConfig } from "../config";
import { AppLock, type Authenticate } from "../lock";
import { IosSession, type Phase } from "../session";
import { expoSqlite } from "../sqlite";
import { AttestNotice, Connecting, Failed, Locked, NotConfigured, SelfTest, SignIn } from "./Front";
import { PhoneContext, useNow, usePhone, useStore, type Phone, type PhoneApp } from "./hooks";
import { Link } from "./Link";
import { Main } from "./Main";
import { Card, Screen, T, s } from "./theme";

const authenticate: Authenticate = async (reason) => (await authenticateAsync({ promptMessage: reason })).success;

/** Builds the session once; `null` when the build carries no relay or issuer config. */
function boot(): Phone | null {
  const config = parseConfig(Constants.expoConfig?.extra);
  if (!config) return null;
  const session = new IosSession<PhoneApp>(
    {
      native: Homerun,
      config,
      deviceName: Constants.deviceName ?? "iPhone",
      cache: new HistoryCache(expoSqlite, () => Homerun.cacheKey()),
    },
    ({ transport, desktopId, role, cache, signApproval }) => ({
      client: new AppClient(transport, { role, cache, signApproval }),
      desktopId,
    }),
  );
  return { session, lock: new AppLock(Homerun, authenticate), authenticate };
}

export function App() {
  // The simulator CI job launches with `-HomerunSelfTest 1` to run the protocol vectors on Hermes (§16.2).
  const [selfTest] = useState(() => Boolean(Defaults.get("HomerunSelfTest")));
  const [phone] = useState(() => (selfTest ? null : boot()));

  useEffect(() => {
    if (!phone) return;
    let gone = false;
    void phone.lock.load().then(() => {
      if (!gone) void phone.session.start();
    });
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "background") {
        phone.lock.background();
        void phone.session.background();
      } else if (st === "active") phone.lock.foreground();
    });
    return () => {
      gone = true;
      sub.remove();
      phone.session.close();
    };
  }, [phone]);

  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      {selfTest ? (
        <SelfTest />
      ) : phone ? (
        <PhoneContext.Provider value={phone}>
          <Root />
        </PhoneContext.Provider>
      ) : (
        <NotConfigured />
      )}
    </SafeAreaProvider>
  );
}

function Root() {
  const { session, lock } = usePhone();
  const phase = useStore(session.phase);
  const locked = useStore(lock.locked);
  // While locked nothing of the account is rendered, not even behind the overlay.
  if (locked) return <Locked />;
  return (
    <>
      <Body phase={phase} />
      <AttestNotice />
    </>
  );
}

function Body({ phase }: { phase: Phase<PhoneApp> }) {
  switch (phase.s) {
    case "starting":
    case "connecting":
      return <Connecting />;
    case "signed_out":
      return <SignIn notice={phase.notice} tone={phase.tone} busy={false} />;
    case "signing_in":
      return <SignIn notice={null} tone="info" busy />;
    case "link":
      return <Link desktops={phase.desktops} step={phase.step} notice={phase.notice} />;
    case "pick":
      return <Pick />;
    case "ready":
      return <Main key={phase.desktopId} app={phase.app} />;
    case "error":
      return <Failed message={phase.message} />;
  }
}

/** Several Macs are paired and none was chosen yet. */
function Pick() {
  const { session } = usePhone();
  const desktops = useStore(session.desktops);
  const now = useNow();
  return (
    <Screen scroll>
      <T style={s.title}>Which Mac?</T>
      {desktops.map((d) => (
        <Pressable key={d.device_id} accessibilityRole="button" onPress={() => void session.show(d.device_id)}>
          <Card>
            <T style={s.h2}>{d.name}</T>
            <T muted style={s.small}>
              {seenText(d, now)}
            </T>
          </Card>
        </Pressable>
      ))}
      <View style={{ height: 12 }} />
    </Screen>
  );
}
