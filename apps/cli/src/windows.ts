/** The Windows peer check's system calls (§5.2). Loaded on first use, and only on Windows. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  authenticode,
  closeHandle,
  currentUserSid,
  GENERIC_READ,
  openPipe,
  pipeServerPid,
  processImagePath,
  processUserSid,
  READ_CONTROL,
  readSecurity,
} from "@homerun/win32";
import type { WindowsPeerInspector } from "./peer";

export function windowsInspector(): WindowsPeerInspector {
  return {
    ownSid: currentUserSid,
    // A client connection of its own: READ_CONTROL for the DACL, GENERIC_READ to connect.
    open: (pipe) => openPipe(pipe, GENERIC_READ | READ_CONTROL),
    close: closeHandle,
    pipeSecurity: (h) => readSecurity(h),
    serverPid: pipeServerPid,
    processSid: processUserSid,
    imagePath: processImagePath,
    sha256: (path) => createHash("sha256").update(readFileSync(path)).digest("hex"),
    authenticode,
  };
}
