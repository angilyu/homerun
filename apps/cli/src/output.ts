export interface Stream {
  write(s: string | Uint8Array): void;
  isTTY?: boolean;
}

export interface Colors {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

const sgr = (on: boolean, open: number, close: number) => (s: string) => (on ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export function colors(on: boolean): Colors {
  return { bold: sgr(on, 1, 22), dim: sgr(on, 2, 22), red: sgr(on, 31, 39), green: sgr(on, 32, 39), yellow: sgr(on, 33, 39), cyan: sgr(on, 36, 39) };
}

/**
 * Where output goes. Human mode: the answer (assistant text, tables) on stdout, progress and
 * notes on stderr, colour only on a terminal. JSON mode: one JSON value per line on stdout.
 */
export class Output {
  readonly c: Colors;
  readonly ce: Colors;

  constructor(
    readonly stdout: Stream,
    readonly stderr: Stream,
    readonly json: boolean,
    color: boolean,
  ) {
    this.c = colors(color && !json && !!stdout.isTTY);
    this.ce = colors(color && !!stderr.isTTY);
  }

  out(s: string | Uint8Array): void {
    this.stdout.write(s);
  }

  line(s = ""): void {
    this.stdout.write(s + "\n");
  }

  note(s: string): void {
    this.stderr.write(s + "\n");
  }

  value(v: unknown): void {
    this.stdout.write(JSON.stringify(v) + "\n");
  }
}

export function colorWanted(env: Record<string, string | undefined>, noColorFlag: boolean): boolean {
  return !noColorFlag && !env.NO_COLOR && env.TERM !== "dumb";
}
