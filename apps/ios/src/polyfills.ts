// What Hermes lacks that the shared packages use (§9.8). Imported first by index.ts.
import "react-native-get-random-values";
import { installRandomUUID } from "./uuid";

installRandomUUID(globalThis.crypto as unknown as Parameters<typeof installRandomUUID>[0]);
