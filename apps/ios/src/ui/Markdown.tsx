import { memo, type ReactNode } from "react";
import { Alert, Linking, ScrollView, Text, View } from "react-native";
import { parseMarkdown, type Block, type Inline } from "@homerun/app-state";
import { s, usePalette, type Palette } from "./theme";

/**
 * Model output as native text from app-state's neutral tree (§9.8): no HTML and no web view, so
 * nothing is injected; images arrive as links and are never loaded (§13). A link says where it
 * goes before it opens, since the text came from a model that may have read untrusted pages.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const p = usePalette();
  return <View style={{ gap: 8 }}>{parseMarkdown(text).map((b, i) => block(b, i, p))}</View>;
});

function openLink(href: string): void {
  Alert.alert("Open this link?", href, [
    { text: "Cancel", style: "cancel" },
    { text: "Open", onPress: () => void Linking.openURL(href).catch(() => {}) },
  ]);
}

function block(b: Block, key: number, p: Palette): ReactNode {
  const body = [s.body, { color: p.text }];
  switch (b.t) {
    case "paragraph":
      return (
        <Text key={key} style={body} selectable>
          {inlines(b.children, p)}
        </Text>
      );
    case "heading":
      return (
        <Text key={key} accessibilityRole="header" style={[body, { fontWeight: "700", fontSize: b.level <= 1 ? 20 : b.level === 2 ? 18 : 16 }]}>
          {inlines(b.children, p)}
        </Text>
      );
    case "code":
      return (
        <ScrollView key={key} horizontal style={{ backgroundColor: p.code, borderRadius: 8 }} contentContainerStyle={{ padding: 10 }}>
          <Text style={[s.mono, { color: p.text }]} selectable>
            {b.text}
          </Text>
        </ScrollView>
      );
    case "quote":
      return (
        <View key={key} style={{ borderLeftWidth: 3, borderLeftColor: p.border, paddingLeft: 10, gap: 6 }}>
          {b.children.map((c, i) => block(c, i, p))}
        </View>
      );
    case "list":
      return (
        <View key={key} style={{ gap: 4 }}>
          {b.items.map((it, i) => (
            <View key={i} style={{ flexDirection: "row", gap: 6 }}>
              <Text style={[body, { minWidth: 18 }]}>{it.checked !== null ? (it.checked ? "☑" : "☐") : b.ordered ? `${b.start + i}.` : "•"}</Text>
              <View style={{ flex: 1, gap: 4 }}>{it.children.map((c, j) => block(c, j, p))}</View>
            </View>
          ))}
        </View>
      );
    case "table":
      return (
        <ScrollView key={key} horizontal>
          <View style={{ borderWidth: 1, borderColor: p.border, borderRadius: 6 }}>
            {[b.header, ...b.rows].map((r, ri) => (
              <View key={ri} style={{ flexDirection: "row", borderTopWidth: ri ? 1 : 0, borderColor: p.border }}>
                {r.map((c, ci) => (
                  <Text
                    key={ci}
                    style={[s.small, { color: p.text, width: 140, padding: 6, fontWeight: ri === 0 ? "600" : "400", textAlign: b.align[ci] ?? "left" }]}
                  >
                    {inlines(c, p)}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    case "hr":
      return <View key={key} style={{ height: 1, backgroundColor: p.border }} />;
  }
}

function inlines(xs: readonly Inline[], p: Palette): ReactNode[] {
  return xs.map((x, i) => inline(x, i, p));
}

function inline(x: Inline, key: number, p: Palette): ReactNode {
  switch (x.t) {
    case "text":
      return x.text;
    case "strong":
      return (
        <Text key={key} style={{ fontWeight: "700" }}>
          {inlines(x.children, p)}
        </Text>
      );
    case "em":
      return (
        <Text key={key} style={{ fontStyle: "italic" }}>
          {inlines(x.children, p)}
        </Text>
      );
    case "del":
      return (
        <Text key={key} style={{ textDecorationLine: "line-through" }}>
          {inlines(x.children, p)}
        </Text>
      );
    case "code":
      return (
        <Text key={key} style={[s.mono, { backgroundColor: p.code }]}>
          {x.text}
        </Text>
      );
    case "br":
      return "\n";
    case "link": {
      const label = x.image ? ["Image: ", ...inlines(x.children, p)] : inlines(x.children, p);
      const href = x.href;
      if (!href) return <Text key={key}>{label}</Text>;
      return (
        <Text key={key} accessibilityRole="link" style={{ color: p.accent, textDecorationLine: "underline" }} onPress={() => openLink(href)}>
          {label}
        </Text>
      );
    }
  }
}
