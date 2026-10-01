import { useState } from "react";
import { Alert, Switch, View } from "react-native";
import { errorMessage, seenText } from "@homerun/app-state";
import { useDesktop, useNow, usePhone, useStore } from "./hooks";
import { Button, Card, ErrorText, Notice, Screen, T, s } from "./theme";

/** The account, paired Macs, the Face ID lock, signing out and deleting the account (§10.9). */
export function Settings() {
  const { session, lock, authenticate } = usePhone();
  const { client, desktopId } = useDesktop();
  const desktops = useStore(session.desktops);
  const lockOn = useStore(lock.enabled);
  const now = useNow();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (what: string, f: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const unpair = (id: string, name: string) =>
    Alert.alert(`Unpair ${name}?`, "This iPhone stops reaching it. You can pair again with its QR code.", [
      { text: "Cancel", style: "cancel" },
      { text: "Unpair", style: "destructive", onPress: () => void run("unpair", () => session.unlink(id)) },
    ]);

  const deleteAccount = () =>
    Alert.alert(
      "Delete your Homerun account?",
      "This deletes your account and sign-in, unpairs every device, and erases this iPhone’s keys and history. Your Macs keep their chats. This can’t be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete account",
          style: "destructive",
          onPress: () =>
            void run("delete", async () => {
              if (!(await authenticate("Delete your Homerun account"))) return;
              await session.deleteAccount();
            }),
        },
      ],
    );

  const role = client.role;
  const approvals =
    role === "web"
      ? "Your Mac couldn’t verify this iPhone with Apple’s App Attest, so it treats it like the web client: it answers questions and read-only approvals; everything else is approved on your Mac."
      : client.signsApprovals
        ? "Destructive calls are approved here with Face ID; your Mac checks each approval’s signature."
        : "Destructive calls are approved on your Mac: this iPhone has no Face ID approval key your Mac accepted.";

  return (
    <Screen scroll>
      <Card>
        <T style={s.h2}>Account</T>
        <T muted>{session.email ?? "Signed in"}</T>
        <Button title="Sign out" busy={busy === "signout"} onPress={() => void run("signout", () => session.signOut())} />
        <T muted style={s.small}>
          Signed out, this iPhone stays paired but gets no notifications.
        </T>
      </Card>

      <Card>
        <T style={s.h2}>Your Macs</T>
        {desktops.map((d) => (
          <View key={d.device_id} style={{ gap: 4 }}>
            <View style={s.row}>
              <T style={{ flex: 1, fontWeight: d.device_id === desktopId ? "600" : "400" }}>{d.name}</T>
              {d.device_id !== desktopId ? <Button kind="link" title="Show" onPress={() => void session.show(d.device_id)} /> : null}
              <Button kind="link" title="Unpair" onPress={() => unpair(d.device_id, d.name)} />
            </View>
            <T muted style={s.small}>
              {seenText(d, now)}
            </T>
          </View>
        ))}
        <Button title="Pair another Mac" onPress={() => void session.linkAnother()} />
      </Card>

      <Card>
        <T style={s.h2}>Approvals</T>
        <T muted style={s.small}>
          {approvals}
        </T>
      </Card>

      <Card>
        <View style={s.row}>
          <T style={{ flex: 1 }}>Lock with Face ID</T>
          <Switch accessibilityLabel="Lock with Face ID" value={lockOn} onValueChange={(on) => void run("lock", () => lock.setEnabled(on))} />
        </View>
        <T muted style={s.small}>
          Asks for Face ID when Homerun opens, and after a minute away.
        </T>
      </Card>

      <Card>
        <T style={s.h2}>Delete account</T>
        <T muted style={s.small}>
          Deletes your Homerun account everywhere, including your sign-in.
        </T>
        <Button kind="danger" title="Delete account…" busy={busy === "delete"} onPress={deleteAccount} />
      </Card>

      <ErrorText error={error} />
      {busy === "unpair" ? <Notice text="Unpairing…" tone="info" /> : null}
    </Screen>
  );
}
