/** Keep-awake (docs/design.md §8.4): the Windows counterpart of `caffeinate -i`. */
import { kernel32 } from "./ffi";

export const ES_CONTINUOUS = 0x8000_0000;
export const ES_SYSTEM_REQUIRED = 0x0000_0001;

/**
 * Set the calling thread's execution state; `ES_CONTINUOUS` makes it last until the next call or
 * the thread's end. Returns the previous state, or 0 on failure.
 */
export function setThreadExecutionState(flags: number): number {
  return kernel32().SetThreadExecutionState(flags >>> 0);
}
