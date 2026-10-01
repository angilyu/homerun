import { useRef, useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import type { LinkedDevice } from "@homerun/protocol";
import type { LinkStep } from "../session";
import { usePhone, useStore } from "./hooks";
import { Button, Card, ErrorText, Loading, Notice, Screen, T, s, usePalette } from "./theme";

/**
 * Pairing a Mac (§9.6, §10.5): scan the QR code its Settings → Remote access shows, or link a Mac
 * already signed in to this account by matching six digits, approved on the Mac.
 */
export function Link({ desktops, step, notice }: { desktops: LinkedDevice[] | null; step: LinkStep; notice: string | null }) {
  const { session } = usePhone();
  const paired = useStore(session.desktops);
  const [scanning, setScanning] = useState(false);

  if (step.k === "pairing") return <Loading text="Pairing…" />;
  if (step.k === "linking") return <LinkCode name={step.name} code={step.code} />;
  if (scanning) return <Scanner onCode={(url) => (setScanning(false), void session.pair(url))} onCancel={() => setScanning(false)} />;

  return (
    <Screen scroll>
      <T style={s.title}>Pair your Mac</T>
      {notice ? <Notice text={notice} tone="info" /> : null}
      {step.k === "declined" ? <Notice text={`${step.name} declined the link.`} /> : null}
      {step.k === "choose" ? <ErrorText error={step.error} /> : null}
      <Card>
        <T style={s.h2}>Scan a QR code</T>
        <T muted style={s.small}>
          In Homerun on your Mac, open Settings → Remote access and choose Pair a phone.
        </T>
        <Button kind="primary" title="Scan QR code" onPress={() => setScanning(true)} />
      </Card>
      <Card>
        <T style={s.h2}>Or link with a code</T>
        {desktops === null ? (
          <T muted style={s.small}>
            Looking for your Macs…
          </T>
        ) : desktops.length === 0 ? (
          <T muted style={s.small}>
            No other Mac is signed in to this account. Sign in on your Mac first, or scan its QR code.
          </T>
        ) : (
          <>
            <T muted style={s.small}>
              Macs signed in to this account. Your Mac asks you to check a six-digit code.
            </T>
            {desktops.map((d) => (
              <Button key={d.device_id} title={d.name} label={`Link ${d.name}`} onPress={() => void session.link(d)} />
            ))}
          </>
        )}
      </Card>
      <View style={s.row}>
        {paired.length > 0 ? <Button kind="link" title="Back" onPress={() => session.back()} /> : null}
        <Button kind="link" title="Sign out" onPress={() => void session.signOut()} />
      </View>
    </Screen>
  );
}

/** This phone's six digits while the Mac asks its person to compare them. */
function LinkCode({ name, code }: { name: string; code: string | null }) {
  const { session } = usePhone();
  return (
    <Screen>
      <View style={s.center}>
        <T style={s.h2}>Linking {name}</T>
        {code ? (
          <>
            <T style={{ fontSize: 44, fontWeight: "700", letterSpacing: 8, fontVariant: ["tabular-nums"] }} selectable={false}>
              {code}
            </T>
            <T muted style={{ textAlign: "center" }}>
              On {name}, check the code matches and choose Link.
            </T>
          </>
        ) : (
          <T muted>Asking {name}…</T>
        )}
        <Button title="Cancel" onPress={() => session.cancelLink()} />
      </View>
    </Screen>
  );
}

/** The camera, reading QR codes until one is a pairing link. The link is never shown or logged. */
function Scanner({ onCode, onCancel }: { onCode: (url: string) => void; onCancel: () => void }) {
  const [permission, request] = useCameraPermissions();
  const p = usePalette();
  const taken = useRef(false);
  if (!permission) return <Loading />;
  if (!permission.granted)
    return (
      <Screen>
        <View style={s.center}>
          <T style={{ textAlign: "center" }}>Homerun needs the camera to scan your Mac’s pairing code.</T>
          {permission.canAskAgain ? (
            <Button kind="primary" title="Allow camera" onPress={() => void request()} />
          ) : (
            <Button kind="primary" title="Open Settings" onPress={() => void Linking.openSettings()} />
          )}
          <Button kind="link" title="Cancel" onPress={onCancel} />
        </View>
      </Screen>
    );
  return (
    <View style={[s.fill, { backgroundColor: "#000" }]}>
      <CameraView
        style={s.fill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => {
          if (taken.current) return;
          taken.current = true;
          onCode(data);
        }}
      />
      <ScrollView style={{ position: "absolute", bottom: 48, left: 0, right: 0 }} contentContainerStyle={{ alignItems: "center", gap: 12 }}>
        <T style={{ color: "#fff" }}>Point at the QR code on your Mac</T>
        <Pressable accessibilityRole="button" onPress={onCancel} style={[s.button, { backgroundColor: p.card }]}>
          <T>Cancel</T>
        </Pressable>
      </ScrollView>
    </View>
  );
}
