import { deflateRawSync } from "node:zlib";

/**
 * A minimal zip writer (PKWARE APPNOTE 6.3: local headers, central directory, end record; deflate
 * or stored; no zip64, so under 4 GB and 65535 entries). Enough for a diagnostic bundle without a
 * dependency.
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function zip(entries: ZipEntry[], at = new Date()): Uint8Array {
  const { time, date } = dosTime(at);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = new TextEncoder().encode(e.name);
    const crc = Bun.hash.crc32(e.data) >>> 0;
    const deflated = deflateRawSync(e.data);
    const store = deflated.length >= e.data.length;
    const body = store ? e.data : new Uint8Array(deflated);
    const method = store ? 0 : 8;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, body);

    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, method, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, body.length, true);
    c.setUint32(24, e.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(38, 0o100644 << 16, true); // external attributes: a regular file, rw-r--r--
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of all) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Read back a zip this module wrote (tests): name → contents. */
export function unzip(buf: Uint8Array): Map<string, Uint8Array> {
  const { inflateRawSync } = require("node:zlib") as typeof import("node:zlib");
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Map<string, Uint8Array>();
  let o = 0;
  while (v.getUint32(o, true) === 0x04034b50) {
    const method = v.getUint16(o + 8, true);
    const size = v.getUint32(o + 18, true);
    const nameLen = v.getUint16(o + 26, true);
    const extra = v.getUint16(o + 28, true);
    const name = new TextDecoder().decode(buf.subarray(o + 30, o + 30 + nameLen));
    const start = o + 30 + nameLen + extra;
    const body = buf.subarray(start, start + size);
    out.set(name, method === 8 ? new Uint8Array(inflateRawSync(body)) : body);
    o = start + size;
  }
  return out;
}
