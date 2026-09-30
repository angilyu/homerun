/**
 * Draws the menu-bar icons (§5.1) as macOS template images: black with alpha, 18 pt at 2x, so
 * AppKit tints them for light and dark menu bars. A home plate outline; "attention" adds a dot
 * (something is waiting for you), "trouble" a slash (the runtime can't run). Run once and commit
 * the PNGs: `bun scripts/tray-icons.ts`. No image library: 4×4 supersampling and node:zlib.
 *
 * Windows has no template images and its taskbar may be light or dark, so it gets coloured
 * copies (`tray-*-win.png`): a blue plate, an amber dot, a red slash. It also writes the app's
 * `icon.ico` from the committed app PNGs (32, 128 and 256 px, stored as PNG), which tauri-build
 * embeds in the Windows executable.
 */
import { deflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
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
    if (d <= 5.5) return 2;
    if (d <= 8.5) return 0; // a clear ring so the dot reads against the outline
  }
  if (kind === "trouble") {
    const d = segDist(p, slash[0], slash[1]);
    if (d <= 1.75) return 2;
    if (d <= 4) return 0;
  }
  return outline(p, 3) ? 1 : 0;
}

type Rgb = [number, number, number];
const BLACK: Rgb = [0, 0, 0];
/** Windows: readable on a light and a dark taskbar alike. */
const WIN: Record<string, Rgb> = { plate: [0x25, 0x63, 0xeb], attention: [0xf5, 0x9e, 0x0b], trouble: [0xdc, 0x26, 0x26] };

function png(kind: string, windows = false): Buffer {
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0;
    for (let x = 0; x < S; x++) {
      let a = 0;
      const rgb = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const c = coverage(kind, [x + (sx + 0.5) / SS, y + (sy + 0.5) / SS]);
          if (!c) continue;
          a++;
          const col = !windows ? BLACK : c === 2 ? WIN[kind]! : WIN.plate!;
          for (let i = 0; i < 3; i++) rgb[i]! += col[i]!;
        }
      const at = y * (S * 4 + 1) + 1 + x * 4;
      if (a) for (let i = 0; i < 3; i++) raw[at + i] = Math.round(rgb[i]! / a);
      raw[at + 3] = Math.round((255 * a) / (SS * SS));
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

/** An .ico whose images are PNGs (Windows Vista and later read these). */
function ico(pngs: Buffer[]): Buffer {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach((p, i) => {
    const [w, h] = [p.readUInt32BE(16), p.readUInt32BE(20)];
    const e = 6 + 16 * i;
    head[e] = w >= 256 ? 0 : w;
    head[e + 1] = h >= 256 ? 0 : h;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(p.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += p.length;
  });
  return Buffer.concat([head, ...pngs]);
}

const dir = join(import.meta.dir, "..", "src-tauri", "icons");
for (const kind of ["normal", "attention", "trouble"]) {
  writeFileSync(join(dir, `tray-${kind}.png`), png(kind));
  writeFileSync(join(dir, `tray-${kind}-win.png`), png(kind, true));
}
writeFileSync(join(dir, "icon.ico"), ico(["32x32.png", "128x128.png", "128x128@2x.png"].map((f) => readFileSync(join(dir, f)))));
console.log(`wrote tray-{normal,attention,trouble}{,-win}.png and icon.ico to ${dir}`);
