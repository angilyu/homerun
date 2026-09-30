import type { Colors, Stream } from "./output";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** "1:52" */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * What the CLI shows while the app asks the user (§5.2). On stderr, so stdout stays clean for
 * --json. On a terminal: a spinner and the time left, redrawn in place. Otherwise: one line when
 * it starts and one when it ends.
 */
export class Waiting {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private expiresAt = 0;

  constructor(
    private err: Stream,
    private tty: boolean,
    private c: Colors,
    private now: () => number = Date.now,
  ) {}

  start(expiresAt: number): void {
    this.expiresAt = expiresAt;
    this.err.write("Homerun needs to approve this command-line tool.\n");
    this.err.write(this.c.dim(`  Click "Allow" in the Homerun app. ${this.tty ? "Ctrl-C cancels." : `It waits up to ${mmss(expiresAt - this.now())}.`}`) + "\n");
    if (!this.tty) return;
    this.draw();
    this.timer = setInterval(() => this.draw(), 100);
  }

  /** The spinner line, as drawn now. */
  line(): string {
    return `${this.c.cyan(SPINNER[this.frame % SPINNER.length]!)} Waiting for approval… ${mmss(this.expiresAt - this.now())}`;
  }

  private draw(): void {
    this.err.write(`\r${this.line()}\x1b[K`);
    this.frame++;
  }

  /** Stop, and print the outcome in place of the spinner. */
  finish(text: string): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.err.write(this.tty ? `\r\x1b[K${text}\n` : `${text}\n`);
  }
}
