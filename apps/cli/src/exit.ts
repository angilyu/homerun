/** Exit codes (sysexits where one fits). */
export const EXIT = {
  OK: 0,
  /** An error, or a run that failed, was cancelled or was abandoned. */
  ERROR: 1,
  /** Bad usage, or a development-only switch in a release build. */
  USAGE: 64,
  /** homerund is not running. */
  UNAVAILABLE: 69,
  /** The run is waiting for input. */
  WAITING_INPUT: 75,
  /** Not authorized. */
  NOPERM: 77,
  /** Ctrl-C: detached from (or stopped) the run. */
  INTERRUPTED: 130,
} as const;

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: number = EXIT.ERROR,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export const usageError = (message: string, hint?: string) => new CliError(message, EXIT.USAGE, hint);
