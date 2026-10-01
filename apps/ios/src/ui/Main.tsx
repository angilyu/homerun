import { useEffect, useLayoutEffect, useState } from "react";
import { ActionSheetIOS, Pressable, RefreshControl, SectionList, View, useColorScheme } from "react-native";
import { DarkTheme, DefaultTheme, NavigationContainer, createNavigationContainerRef, useNavigation, type RouteProp } from "@react-navigation/native";
import { createNativeStackNavigator, type NativeStackNavigationProp } from "@react-navigation/native-stack";
import { ago, groupThreads, inTime } from "@homerun/app-state";
import type { ThreadSummary } from "@homerun/core";
import { Chat, NewChat, StatusBanner } from "./Chat";
import { promptTitle } from "./InputCards";
import { DesktopContext, useDesktop, useNow, usePhone, useStore, type PhoneApp } from "./hooks";
import { Settings } from "./Settings";
import { Badge, Button, Card, ErrorText, Screen, T, s, usePalette } from "./theme";

export type Routes = {
  Threads: undefined;
  Chat: { threadId: string };
  NewChat: undefined;
  Inbox: undefined;
  Settings: undefined;
};

type Nav = NativeStackNavigationProp<Routes>;

const Stack = createNativeStackNavigator<Routes>();

/** A paired desktop on screen: its threads, chats, inbox and the app's settings. */
export function Main({ app }: { app: PhoneApp }) {
  const { session } = usePhone();
  const dark = useColorScheme() === "dark";
  const [nav] = useState(() => createNavigationContainerRef<Routes>());
  const desktops = useStore(session.desktops);
  const name = desktops.find((d) => d.device_id === app.desktopId)?.name ?? "Your Mac";

  // A tapped notification opens its thread, or the inbox for a request without one.
  const focus = useStore(session.focus);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!focus || !ready || focus.desktopId !== app.desktopId) return;
    session.focus.set(null);
    if (focus.threadId) nav.navigate("Chat", { threadId: focus.threadId });
    else if (focus.requestId) nav.navigate("Inbox");
  }, [focus, ready, app.desktopId, nav, session]);

  return (
    <DesktopContext.Provider value={app}>
      <NavigationContainer ref={nav} theme={dark ? DarkTheme : DefaultTheme} onReady={() => setReady(true)}>
        <Stack.Navigator>
          <Stack.Screen name="Threads" component={Threads} options={{ title: name }} />
          <Stack.Screen name="Chat" options={{ title: "" }}>
            {({ route }: { route: RouteProp<Routes, "Chat"> }) => <Chat threadId={route.params.threadId} />}
          </Stack.Screen>
          <Stack.Screen name="NewChat" component={NewChat} options={{ title: "New chat" }} />
          <Stack.Screen name="Inbox" component={Inbox} options={{ title: "Waiting for you" }} />
          <Stack.Screen name="Settings" component={Settings} />
        </Stack.Navigator>
      </NavigationContainer>
    </DesktopContext.Provider>
  );
}

/** Switches between paired Macs, or pairs another. */
function chooseDesktop(session: ReturnType<typeof usePhone>["session"], current: string): void {
  const list = session.desktops.get();
  const labels = list.map((d) => `${d.name}${d.online ? "" : " (offline)"}${d.device_id === current ? " ✓" : ""}`);
  ActionSheetIOS.showActionSheetWithOptions({ title: "Your Macs", options: [...labels, "Pair another Mac…", "Cancel"], cancelButtonIndex: labels.length + 1 }, (i) => {
    if (i < list.length) void session.show(list[i]!.device_id);
    else if (i === list.length) void session.linkAnother();
  });
}

function Threads() {
  const { session } = usePhone();
  const { client, desktopId } = useDesktop();
  const nav = useNavigation<Nav>();
  const list = useStore(client.threads.store);
  const inbox = useStore(client.inbox.store);
  const desktops = useStore(session.desktops);
  const [refreshing, setRefreshing] = useState(false);

  useLayoutEffect(() => {
    nav.setOptions({
      headerLeft: () => <Button kind="link" title={desktops.length > 1 ? "Macs" : "Pair"} label="Switch Mac" onPress={() => chooseDesktop(session, desktopId)} />,
      headerRight: () => (
        <View style={s.row}>
          <Button kind="link" title="Settings" onPress={() => nav.navigate("Settings")} />
          <Button kind="link" title="New" label="New chat" onPress={() => nav.navigate("NewChat")} />
        </View>
      ),
    });
  }, [nav, session, desktopId, desktops.length]);

  const g = groupThreads(list.threads);
  const sections = [
    { title: "Needs you", data: g.needs_you },
    { title: "Running", data: g.running },
    { title: "Recent", data: g.recent },
  ].filter((x) => x.data.length > 0);

  return (
    <Screen>
      <StatusBanner />
      {inbox.entries.length > 0 ? (
        <Pressable accessibilityRole="button" onPress={() => nav.navigate("Inbox")} style={{ marginHorizontal: 12, marginTop: 8 }}>
          <Card>
            <T style={s.h2}>{inbox.entries.length === 1 ? "1 thing is waiting for you" : `${inbox.entries.length} things are waiting for you`}</T>
            <T muted style={s.small}>
              {promptTitle(inbox.entries[0]!.request.prompt)}
            </T>
          </Card>
        </Pressable>
      ) : null}
      <ErrorText error={list.error} />
      <SectionList
        sections={sections}
        keyExtractor={(t) => t.thread_id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ padding: 12, gap: 6 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void Promise.all([client.threads.load(), client.inbox.refresh()]).finally(() => setRefreshing(false));
            }}
          />
        }
        onEndReached={() => list.has_more && void client.threads.loadMore()}
        renderSectionHeader={({ section }) => (
          <T muted style={[s.small, { marginTop: 12, textTransform: "uppercase" }]}>
            {section.title}
          </T>
        )}
        renderItem={({ item }) => <ThreadRow t={item} onPress={() => nav.navigate("Chat", { threadId: item.thread_id })} />}
        ListEmptyComponent={
          list.loaded ? (
            <View style={s.center}>
              <T muted>No chats yet.</T>
              <Button kind="primary" title="New chat" onPress={() => nav.navigate("NewChat")} />
            </View>
          ) : null
        }
      />
    </Screen>
  );
}

function ThreadRow({ t, onPress }: { t: ThreadSummary; onPress: () => void }) {
  const p = usePalette();
  const now = useNow();
  const title = t.title ?? t.last_message?.preview.slice(0, 60) ?? "New chat";
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      <View style={{ backgroundColor: p.card, borderRadius: 12, padding: 12, gap: 4 }}>
        <View style={s.row}>
          <T style={[s.h2, { flex: 1 }]}>{title}</T>
          {t.unread_count > 0 ? <Badge tone="info">{String(t.unread_count)}</Badge> : null}
        </View>
        {t.last_message ? (
          <T muted style={s.small}>
            {t.last_message.preview.split("\n")[0]}
          </T>
        ) : null}
        <T muted style={s.small}>
          {t.input_pending ? "Waiting for you · " : t.active_run ? "Working · " : ""}
          {ago(t.updated_at, now)}
        </T>
      </View>
    </Pressable>
  );
}

/** Everything waiting for you on this Mac (§5.6). Answers happen in the chat. */
function Inbox() {
  const { client } = useDesktop();
  const nav = useNavigation<Nav>();
  const inbox = useStore(client.inbox.store);
  const list = useStore(client.threads.store);
  const now = useNow();
  const titleOf = (id: string | null) => {
    const t = id ? list.threads.find((x) => x.thread_id === id) : undefined;
    return t?.title ?? t?.last_message?.preview.slice(0, 60) ?? "a chat";
  };
  return (
    <Screen scroll>
      <StatusBanner />
      <ErrorText error={inbox.error} />
      {inbox.loaded && inbox.entries.length === 0 ? <T muted>Nothing needs you right now.</T> : null}
      {inbox.entries.map(({ request, thread_id }) => (
        <Pressable key={request.request_id} accessibilityRole="button" disabled={!thread_id} onPress={() => thread_id && nav.navigate("Chat", { threadId: thread_id })}>
          <Card>
            <T style={s.h2}>{promptTitle(request.prompt)}</T>
            <T muted style={s.small}>
              In {titleOf(thread_id)} · {ago(request.requested_at, now)}
              {request.expires_at ? ` · expires ${inTime(request.expires_at, now)}` : ""}
            </T>
          </Card>
        </Pressable>
      ))}
    </Screen>
  );
}
