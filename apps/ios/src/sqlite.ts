import { deleteDatabaseAsync, openDatabaseAsync } from "expo-sqlite";
import type { SqlDriver } from "./cache";

/** The history cache's file (SQLCipher: expo-sqlite is built with `useSQLCipher`). */
const NAME = "history.db";

export const expoSqlite: SqlDriver = {
  open: () => openDatabaseAsync(NAME),
  remove: () => deleteDatabaseAsync(NAME),
};
