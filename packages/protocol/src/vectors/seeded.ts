import { concat, utf8 } from "../bytes";
import { hash, type Random } from "../crypto";

/**
 * A deterministic byte stream (SHA-256 in counter mode over a label) so the vector generator
 * writes the same files every time. For test vectors only: never for real keys.
 */
export function seededRandom(label: string): Random {
  let counter = 0;
  let buf = new Uint8Array(0);
  return (n: number) => {
    while (buf.length < n) {
      const block = hash(concat(utf8(`homerun/test-vectors/${label}/`), utf8(String(counter++))));
      buf = concat(buf, block);
    }
    const out = buf.slice(0, n);
    buf = buf.slice(n);
    return out;
  };
}
