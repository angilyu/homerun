/**
 * Draws the menu-bar icons (§5.1) as macOS template images: black with alpha, 18 pt at 2x, so
 * AppKit tints them for light and dark menu bars. A home plate outline; "attention" adds a dot
 * (something is waiting for you), "trouble" a slash (the runtime can't run). Run once and commit
 * the PNGs: `bun scripts/tray-icons.ts`. No image library: 4×4 supersampling and node:zlib.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const S = 36;
const SS = 4;
type Pt = [number, number];
const plate: Pt[] = [
  [7, 5],
  [29, 5],
  [29, 19],
  [18, 31],
  [7, 19],
];

function segDist(p: Pt, a: Pt, b: Pt): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function outline(p: Pt, w: number): boolean {
  return plate.some((a, i) => segDist(p, a, plate[(i + 1) % plate.length]!) <= w / 2);
}

function coverage(kind: string, p: Pt): number {
  const dot: Pt = [28, 8];
  const slash: [Pt, Pt] = [
    [5, 31],
    [31, 5],
  ];
  if (kind === "attention") {
    const d = Math.hypot(p[0] - dot[0], p[1] - dot[1]);
    if (d <= 5.5) return 1;
    if (d <= 8.5) return 0; // a clear ring so the dot reads against the outline
  }
  if (kind === "trouble") {
    const d = segDist(p, slash[0], slash[1]);
    if (d <= 1.75) return 1;
    if (d <= 4) return 0;
  }
  return outline(p, 3) ? 1 : 0;
}

function png(kind: string): Buffer {
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0;
    for (let x = 0; x < S; x++) {
      let a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) a += coverage(kind, [x + (sx + 0.5) / SS, y + (sy + 0.5) / SS]);
      raw[y * (S * 4 + 1) + 1 + x * 4 + 3] = Math.round((255 * a) / (SS * SS));
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const dir = join(import.meta.dir, "..", "src-tauri", "icons");
for (const kind of ["normal", "attention", "trouble"]) writeFileSync(join(dir, `tray-${kind}.png`), png(kind));
console.log(`wrote tray-{normal,attention,trouble}.png to ${dir}`);
