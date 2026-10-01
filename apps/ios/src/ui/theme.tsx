import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, useColorScheme, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

/** System colours, light and dark, close to the desktop's palette. */
export interface Palette {
  bg: string;
  card: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  onAccent: string;
  danger: string;
  warn: string;
  ok: string;
  bubble: string;
  code: string;
}

const LIGHT: Palette = {
  bg: "#f2f2f7",
  card: "#ffffff",
  text: "#1c1c1e",
  muted: "#6e6e73",
  border: "#d1d1d6",
  accent: "#0a66d8",
  onAccent: "#ffffff",
  danger: "#d70015",
  warn: "#a05a00",
  ok: "#1f7a34",
  bubble: "#dbe8fb",
  code: "#ececf1",
};

const DARK: Palette = {
  bg: "#000000",
  card: "#1c1c1e",
  text: "#f2f2f7",
  muted: "#98989f",
  border: "#38383a",
  accent: "#3d8bff",
  onAccent: "#ffffff",
  danger: "#ff453a",
  warn: "#ffb340",
  ok: "#32d74b",
  bubble: "#1f3a5f",
  code: "#2c2c2e",
};

export function usePalette(): Palette {
  return useColorScheme() === "dark" ? DARK : LIGHT;
}

export const s = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 },
  pad: { padding: 16, gap: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  title: { fontSize: 28, fontWeight: "700" },
  h2: { fontSize: 17, fontWeight: "600" },
  body: { fontSize: 16, lineHeight: 22 },
  small: { fontSize: 13, lineHeight: 18 },
  card: { borderRadius: 12, padding: 14, gap: 8 },
  button: { borderRadius: 10, paddingVertical: 11, paddingHorizontal: 16, alignItems: "center", justifyContent: "center", minHeight: 44 },
  mono: { fontFamily: "Menlo", fontSize: 13 },
});

/** A full-height screen with the system background. */
export function Screen({ children, scroll = false, style }: { children: ReactNode; scroll?: boolean; style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  const inner = scroll ? <ScrollView contentContainerStyle={[s.pad, style]}>{children}</ScrollView> : <View style={[s.fill, style]}>{children}</View>;
  return <SafeAreaView style={[s.fill, { backgroundColor: p.bg }]}>{inner}</SafeAreaView>;
}

export function T({ children, style, muted, tone, selectable, testID }: { children: ReactNode; style?: StyleProp<TextStyle>; muted?: boolean; tone?: "danger" | "warn" | "ok"; selectable?: boolean; testID?: string }) {
  const p = usePalette();
  const color = tone ? p[tone] : muted ? p.muted : p.text;
  return (
    <Text style={[s.body, { color }, style]} selectable={selectable} testID={testID}>
      {children}
    </Text>
  );
}

export function Button({
  title,
  onPress,
  kind = "plain",
  disabled,
  busy,
  label,
}: {
  title: string;
  onPress: () => void;
  kind?: "primary" | "plain" | "danger" | "link";
  disabled?: boolean;
  busy?: boolean;
  label?: string;
}) {
  const p = usePalette();
  const bg = kind === "primary" ? p.accent : kind === "danger" ? p.danger : kind === "link" ? "transparent" : p.card;
  const fg = kind === "primary" || kind === "danger" ? p.onAccent : p.accent;
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? title}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        kind === "link" ? { paddingVertical: 6, minHeight: 32, justifyContent: "center" } : s.button,
        { backgroundColor: bg, opacity: off ? 0.5 : pressed ? 0.7 : 1 },
        kind === "plain" && { borderWidth: StyleSheet.hairlineWidth, borderColor: p.border },
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[s.body, { color: fg, fontWeight: kind === "link" ? "400" : "600" }]}>{title}</Text>}
    </Pressable>
  );
}

export function Card({ children, style, label }: { children: ReactNode; style?: StyleProp<ViewStyle>; label?: string }) {
  const p = usePalette();
  return (
    <View accessibilityLabel={label} style={[s.card, { backgroundColor: p.card }, style]}>
      {children}
    </View>
  );
}

/** Why something can't happen here ("Approve on your Mac"). */
export function Notice({ text, tone = "warn" }: { text: string; tone?: "warn" | "info" }) {
  const p = usePalette();
  return (
    <View accessibilityRole="text" style={{ borderLeftWidth: 3, borderLeftColor: tone === "warn" ? p.warn : p.accent, paddingLeft: 10, paddingVertical: 4 }}>
      <T style={s.small}>{text}</T>
    </View>
  );
}

export function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <T tone="danger" style={s.small}>
      {error}
    </T>
  );
}

export function Badge({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "warn" | "danger" | "ok" | "info" }) {
  const p = usePalette();
  const color = tone === "plain" ? p.muted : tone === "info" ? p.accent : p[tone];
  return (
    <View style={{ borderRadius: 6, borderWidth: 1, borderColor: color, paddingHorizontal: 6, paddingVertical: 1 }}>
      <Text style={[s.small, { color }]}>{children}</Text>
    </View>
  );
}

export function Loading({ text }: { text?: string }) {
  return (
    <Screen>
      <View style={s.center}>
        <ActivityIndicator size="large" />
        {text ? <T muted>{text}</T> : null}
      </View>
    </Screen>
  );
}
