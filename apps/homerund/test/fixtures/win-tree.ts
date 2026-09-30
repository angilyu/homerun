/**
 * A stand-in for `claude` in the Windows process tests: starts a detached grandchild (which no
 * libuv job holds), prints its pid, and waits. `adopt` first puts itself in the runtime's
 * kill-on-close job, as the runtime does at startup; `sleep` just waits.
 */
import { spawn } from "node:child_process";

const mode = process.argv[2];
if (mode === "adopt") (await import("../../src/platform/windows-processes")).windowsProcesses.adoptTree();
if (mode !== "sleep") {
  const g = spawn(process.execPath, [import.meta.path, "sleep"], { detached: true, stdio: "ignore", windowsHide: true });
  g.unref();
  process.stdout.write(`${g.pid}\n`);
}
setInterval(() => {}, 1000);
