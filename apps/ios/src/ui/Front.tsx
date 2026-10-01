import { useEffect, useState } from "react";
import { View } from "react-native";
import { runSelfTest, selfTestLine } from "../selftest";
import { usePhone, useStore } from "./hooks";
import { Button, Loading, Notice, Screen, T, s } from "./theme";

/** Signed out: one button into the identity provider's sheet, which offers Sign in with Apple (§10). */
export function SignIn({ notice, tone, busy }: { notice: string | null; tone: "info" | "warn"; busy: boolean }) {
  const { session } = usePhone();
  return (
    <Screen>
      <View style={s.center}>
        <T style={s.title}>Homerun</T>
        <T muted style={{ textAlign: "center" }}>
          Chat with Claude on your Mac from your iPhone. Your Mac runs everything; this phone sends and receives sealed messages through Homerun’s relay.
        </T>
        {notice ? <Notice text={notice} tone={tone} /> : null}
        <Button kind="primary" title="Sign in" onPress={() => void session.signIn()} busy={busy} />
        <T muted style={[s.small, { textAlign: "center" }]}>
          Use the same account as on your Mac. You can sign in with Apple.
        </T>
      </View>
    </Screen>
  );
}

export function Failed({ message }: { message: string }) {
  const { session } = usePhone();
  return (
    <Screen>
      <View style={s.center}>
        <T style={s.h2}>Something went wrong</T>
        <T muted style={{ textAlign: "center" }}>
          {message}
        </T>
        <Button kind="primary" title="Try again" onPress={() => session.retry()} />
      </View>
    </Screen>
  );
}

/** The Face ID lock on open: nothing shows until it passes. */
export function Locked() {
  const { lock } = usePhone();
  const [failed, setFailed] = useState(false);
  const unlock = async () => setFailed(!(await lock.unlock()));
  useEffect(() => {
    // Asks once on show; after that, the button.
    void unlock();
  }, []);
  return (
    <Screen>
      <View style={s.center}>
        <T style={s.h2}>Homerun is locked</T>
        {failed ? <T muted>Face ID didn’t pass.</T> : null}
        <Button kind="primary" title="Unlock" onPress={() => void unlock()} />
      </View>
    </Screen>
  );
}

/** A build without `HOMERUN_IOS_*` (see apps/ios/README.md). */
export function NotConfigured() {
  return (
    <Screen>
      <View style={s.center}>
        <T style={s.h2}>This build isn’t configured</T>
        <T muted style={{ textAlign: "center" }}>
          It has no relay or sign-in settings. Build it with HOMERUN_IOS_RELAY_URL, HOMERUN_IOS_OIDC_ISSUER and HOMERUN_IOS_OIDC_CLIENT_ID set.
        </T>
      </View>
    </Screen>
  );
}

/**
 * The protocol vectors under Hermes (§16.2), for the nightly simulator job, which launches the
 * app with `-HomerunSelfTest 1` and reads this line through `report` (scripts/sim-selftest.sh).
 * Nothing else starts.
 */
export function SelfTest({ report }: { report: (line: string) => Promise<void> }) {
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => {
    void runSelfTest()
      .then(selfTestLine)
      .catch((e: unknown) => `vectors: self-test crashed (${e instanceof Error ? e.name : "error"})`)
      .then((l) => {
        // Also in the unified log, for someone watching Console.app.
        console.error(`HomerunSelfTest ${l}`);
        setLine(l);
        return report(l);
      })
      .catch(() => console.error("HomerunSelfTest couldn't report the result"));
  }, [report]);
  return (
    <Screen>
      <View style={s.center}>
        <T style={s.h2}>Self-test</T>
        <T testID="selftest" selectable>
          {line ?? "running…"}
        </T>
      </View>
    </Screen>
  );
}

export function Connecting() {
  return <Loading text="Connecting…" />;
}

/** The Face ID notice from pairing or renewing the approval key, once. */
export function AttestNotice() {
  const { session } = usePhone();
  const notice = useStore(session.attester.notice);
  if (!notice) return null;
  return (
    <View style={{ padding: 12, gap: 6 }}>
      <Notice text={notice} />
      <Button kind="link" title="OK" onPress={() => session.attester.notice.set(null)} />
    </View>
  );
}
