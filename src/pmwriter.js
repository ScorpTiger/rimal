// Minimal PMTiles v3 writer (two passes, streamed): turns tiles stored in the app into a map file
// that survives a reinstall and can be copied to another device by USB.
import { gzipSync } from 'fflate';

export function tileid(z, x, y) {
  let acc = (4 ** z - 1) / 3;
  for (let a = z - 1; a >= 0; a--) {
    const s = 2 ** a;
    const rx = (x & s) ? 1 : 0, ry = (y & s) ? 1 : 0;
    acc += ((3 * rx) ^ ry) * s * s;
    if (ry === 0) { if (rx === 1) { x = s - 1 - x; y = s - 1 - y; } [x, y] = [y, x]; }
  }
  return acc;
}
function varint(n, out) { while (n > 0x7f) { out.push((n % 128) | 0x80); n = Math.floor(n / 128); } out.push(n); }
function serializeDir(entries) {
  const b = []; varint(entries.length, b);
  let last = 0; for (const e of entries) { varint(e[0] - last, b); last = e[0]; }
  for (const e of entries) varint(e[3], b);
  for (const e of entries) varint(e[2], b);
  entries.forEach((e, i) => varint(i > 0 && e[1] === entries[i - 1][1] + entries[i - 1][2] ? 0 : e[1] + 1, b));
  return gzipSync(new Uint8Array(b), { level: 9 });
}
function buildDirs(entries) {
  const limit = 16384 - 127;
  let root = serializeDir(entries);
  if (root.length <= limit) return { root, leaves: new Uint8Array(0) };
  for (let leafSize = 4096; ; leafSize = Math.floor(leafSize * 1.2)) {
    const roots = [], parts = []; let off = 0;
    for (let i = 0; i < entries.length; i += leafSize) {
      const chunk = entries.slice(i, i + leafSize), lb = serializeDir(chunk);
      roots.push([chunk[0][0], off, lb.length, 0]); parts.push(lb); off += lb.length;
    }
    root = serializeDir(roots);
    if (root.length <= limit) { const leaves = new Uint8Array(off); let p = 0; for (const x of parts) { leaves.set(x, p); p += x.length; } return { root, leaves }; }
  }
}
const u64 = (v, dv, o) => { dv.setUint32(o, v % 2 ** 32, true); dv.setUint32(o + 4, Math.floor(v / 2 ** 32), true); };

/**
 * tiles: array of [z, x, y]; read(z,x,y) → Promise<Uint8Array|null>; write(Uint8Array) → Promise (appends to the file).
 * Returns { tiles, bytes } written. tileType: 3 = jpeg, 2 = png, 4 = webp.
 */
export async function writePMTiles({ tiles, read, write, meta, bounds, tileType = 3, onProgress }) {
  const list = tiles.map(([z, x, y]) => ({ id: tileid(z, x, y), z, x, y })).sort((a, b) => a.id - b.id);
  // Pass 1: sizes.
  const entries = []; let off = 0, n = 0, minZ = 99, maxZ = 0;
  for (const t of list) {
    const d = await read(t.z, t.x, t.y);
    if (d && d.byteLength) { entries.push([t.id, off, d.byteLength, 1]); t.len = d.byteLength; off += d.byteLength; minZ = Math.min(minZ, t.z); maxZ = Math.max(maxZ, t.z); }
    if (++n % 200 === 0) onProgress?.(0.4 * n / list.length);
  }
  if (!entries.length) throw new Error('no stored tiles in this area');
  const dataLen = off;
  const { root, leaves } = buildDirs(entries);
  const metaBytes = gzipSync(new TextEncoder().encode(JSON.stringify(meta)));
  const rootOff = 127, metaOff = rootOff + root.length, leafOff = metaOff + metaBytes.length, dataOff = leafOff + leaves.length;
  const h = new ArrayBuffer(127), dv = new DataView(h), hb = new Uint8Array(h);
  hb.set(new TextEncoder().encode('PMTiles'), 0); hb[7] = 3;
  [rootOff, root.length, metaOff, metaBytes.length, leafOff, leaves.length, dataOff, dataLen, entries.length, entries.length, entries.length].forEach((v, i) => u64(v, dv, 8 + i * 8));
  hb[96] = 1; hb[97] = 2; hb[98] = 1; hb[99] = tileType; hb[100] = minZ; hb[101] = maxZ;
  const e7 = (v) => Math.round(v * 1e7);
  dv.setInt32(102, e7(bounds[0]), true); dv.setInt32(106, e7(bounds[1]), true); dv.setInt32(110, e7(bounds[2]), true); dv.setInt32(114, e7(bounds[3]), true);
  hb[118] = Math.min(maxZ, 15); dv.setInt32(119, e7((bounds[0] + bounds[2]) / 2), true); dv.setInt32(123, e7((bounds[1] + bounds[3]) / 2), true);
  const head = new Uint8Array(dataOff); head.set(hb, 0); head.set(root, rootOff); head.set(metaBytes, metaOff); head.set(leaves, leafOff);
  await write(head);
  // Pass 2: tile data in the same order, written in ~4 MB blocks.
  let buf = [], bufLen = 0, done = 0;
  const flush = async () => { if (!bufLen) return; const out = new Uint8Array(bufLen); let p = 0; for (const x of buf) { out.set(x, p); p += x.length; } await write(out); buf = []; bufLen = 0; };
  for (const t of list) {
    if (!t.len) continue;
    let d = await read(t.z, t.x, t.y);
    d = d && d.byteLength === t.len ? d : new Uint8Array(t.len); // tile changed meanwhile: keep offsets valid
    buf.push(d); bufLen += d.byteLength;
    if (bufLen > 4e6) await flush();
    if (++done % 200 === 0) onProgress?.(0.4 + 0.6 * done / entries.length);
  }
  await flush(); onProgress?.(1);
  return { tiles: entries.length, bytes: dataOff + dataLen };
}
