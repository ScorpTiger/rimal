// Imagery + terrain tiles. One lookup chain for every tile:
//   1. installed offline packs (.pmtiles)   2. on-device tile cache (downloaded areas + everything seen online)
//   3. the internet, if connected — and the tile is kept for offline use
//   4. a higher-detail crop of the best lower-zoom tile we have, so the map is never blank.
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { PMTiles } from 'pmtiles';

export const SAT_SOURCES = {
  eox: {
    name: 'Sentinel-2 cloudless 2024 (EOX) — 10 m, free',
    url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg',
    maxzoom: 14,
    attribution: '<a href="https://s2maps.eu">Sentinel-2 cloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2024)',
    licence: 'Free for non-commercial use with attribution. Whole-country coverage, about 10 m per pixel — dunes, wadis and escarpments are clear; single tracks are not.',
  },
  esri: {
    name: 'Esri World Imagery — sub-metre',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxzoom: 18,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    licence: 'Very sharp — individual tracks and vehicles visible. Esri’s terms of use apply to you; large offline downloads may require an ArcGIS licence.',
  },
  custom: {
    name: 'Custom imagery URL',
    url: '',
    maxzoom: 18,
    attribution: 'Custom imagery',
    licence: 'Any XYZ tile URL you have the right to use, e.g. https://…/{z}/{x}/{y}.jpg',
  },
};
export const DEM_SOURCE = {
  url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  maxzoom: 15,
  attribution: 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">Mapzen / AWS Open Data</a> (SRTM, GMTED, ETOPO)',
};

const cfg = { satSource: 'eox', customUrl: '', cacheWhileBrowsing: true };
export function configure(o) { Object.assign(cfg, o); }
export function satSource() {
  const s = SAT_SOURCES[cfg.satSource] || SAT_SOURCES.eox;
  return cfg.satSource === 'custom' ? { ...s, url: cfg.customUrl } : s;
}
const layerKey = (layer) => (layer === 'sat' ? `sat:${cfg.satSource}` : 'dem');
const urlFor = (layer, z, x, y) => (layer === 'sat' ? satSource().url : DEM_SOURCE.url).replace('{z}', z).replace('{x}', x).replace('{y}', y);

/* ---------------- offline packs ---------------- */
const packs = { sat: [], dem: [] }; // newest first: { name, pm, minZoom, maxZoom }
export function setPacks(kind, list) { packs[kind] = list; }
export function packMaxZoom(kind) { return Math.max(0, ...packs[kind].map((p) => p.maxZoom)); }

/* ---------------- IndexedDB tile cache ---------------- */
let dbp;
function db() {
  // Shares the app database; the 'tiles' store is created by storage.js (v2).
  return (dbp ||= new Promise((res, rej) => { const r = indexedDB.open('rimal', 2); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
}
async function cacheGet(key) {
  const d = await db();
  return new Promise((res) => { const q = d.transaction('tiles').objectStore('tiles').get(key); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); });
}
async function cacheHas(keys) {
  const d = await db();
  return new Promise((res) => {
    const st = d.transaction('tiles').objectStore('tiles'); const out = new Set(); let n = keys.length;
    if (!n) return res(out);
    for (const k of keys) { const q = st.getKey(k); q.onsuccess = () => { if (q.result !== undefined) out.add(k); if (--n === 0) res(out); }; q.onerror = () => { if (--n === 0) res(out); }; }
  });
}
let pending = [], flushT;
function cachePut(key, buf) {
  pending.push([key, buf]);
  if (pending.length >= 40) return flush();
  clearTimeout(flushT); flushT = setTimeout(flush, 400);
}
async function flush() {
  clearTimeout(flushT);
  const batch = pending; pending = [];
  if (!batch.length) return;
  const d = await db();
  await new Promise((res) => { const t = d.transaction('tiles', 'readwrite'); const st = t.objectStore('tiles'); for (const [k, v] of batch) st.put(v, k); t.oncomplete = res; t.onerror = res; t.onabort = res; });
}
export async function cacheDelete(keys) {
  const d = await db();
  await new Promise((res) => { const t = d.transaction('tiles', 'readwrite'); const st = t.objectStore('tiles'); for (const k of keys) st.delete(k); t.oncomplete = res; t.onerror = res; });
}
export async function cacheStats() {
  const d = await db();
  return new Promise((res) => { const q = d.transaction('tiles').objectStore('tiles').count(); q.onsuccess = () => res(q.result); q.onerror = () => res(0); });
}

/* ---------------- network ---------------- */
let offlineUntil = 0;
export const resetOnline = () => { offlineUntil = 0; };
export const isOnline = () => navigator.onLine !== false && Date.now() > offlineUntil;
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }

export async function netFetch(url, signal, timeout = 15000) {
  if (Capacitor.isNativePlatform()) {
    // Native HTTP: no CORS limits on tile servers.
    const r = await CapacitorHttp.get({ url, responseType: 'arraybuffer', connectTimeout: timeout, readTimeout: timeout, headers: { 'User-Agent': 'RimalOffRoad/2.0' } });
    if (r.status === 404 || r.status === 204) return null;
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    return typeof r.data === 'string' ? b64ToBytes(r.data) : new Uint8Array(r.data);
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  signal?.addEventListener('abort', () => ctl.abort());
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (r.status === 404 || r.status === 204) return null;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return new Uint8Array(await r.arrayBuffer());
  } finally { clearTimeout(t); }
}

/** JSON over HTTP; native HTTP on Android (it returns JSON already parsed). */
export async function netJSON(url, timeout = 15000) {
  if (Capacitor.isNativePlatform()) {
    const r = await CapacitorHttp.get({ url, responseType: 'json', connectTimeout: timeout, readTimeout: timeout });
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/* ---------------- lookup chain ---------------- */
async function fromPacks(layer, z, x, y) {
  for (const p of packs[layer]) {
    if (z < p.minZoom || z > p.maxZoom) continue;
    try { const r = await p.pm.getZxy(z, x, y); if (r?.data?.byteLength) return new Uint8Array(r.data); } catch { /* corrupt or missing */ }
  }
  return null;
}
async function local(layer, z, x, y) {
  const p = await fromPacks(layer, z, x, y);
  if (p) return p;
  const c = await cacheGet(`${layerKey(layer)}/${z}/${x}/${y}`);
  return c ? new Uint8Array(c) : null; // cache stores ArrayBuffers
}

let browseBytes = 0;
const BROWSE_CAP = 3e9;
export async function getTile(layer, z, x, y, { network = true, signal } = {}) {
  const hit = await local(layer, z, x, y);
  if (hit) return { data: hit, from: 'offline' };
  const srcMax = layer === 'sat' ? satSource().maxzoom : DEM_SOURCE.maxzoom;
  const url = layer === 'sat' ? satSource().url : DEM_SOURCE.url;
  if (network && url && z <= srcMax && isOnline()) {
    try {
      const data = await netFetch(urlFor(layer, z, x, y), signal);
      if (data && data.byteLength) {
        if (cfg.cacheWhileBrowsing && browseBytes < BROWSE_CAP) { cachePut(`${layerKey(layer)}/${z}/${x}/${y}`, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)); browseBytes += data.byteLength; }
        return { data, from: 'net' };
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      offlineUntil = Date.now() + 20000; // back off: probably no connectivity
    }
  }
  const up = await fromParent(layer, z, x, y);
  return up ? { data: up, from: 'upscaled' } : null;
}

const bmpCache = new Map();
async function bitmap(layer, z, x, y) {
  const k = `${layer}/${z}/${x}/${y}`;
  if (bmpCache.has(k)) return bmpCache.get(k);
  const data = await local(layer, z, x, y);
  const b = data ? await createImageBitmap(new Blob([data])).catch(() => null) : null;
  bmpCache.set(k, b);
  if (bmpCache.size > 48) { const first = bmpCache.keys().next().value; bmpCache.get(first)?.close?.(); bmpCache.delete(first); }
  return b;
}
async function fromParent(layer, z, x, y) {
  for (let dz = 1; dz <= 10 && z - dz >= 0; dz++) {
    const pz = z - dz, px = x >> dz, py = y >> dz;
    const bmp = await bitmap(layer, pz, px, py);
    if (!bmp) continue;
    const n = 1 << dz, size = bmp.width / n;
    const sx = (x - (px << dz)) * size, sy = (y - (py << dz)) * size;
    const c = new OffscreenCanvas(256, 256);
    const g = c.getContext('2d');
    if (layer === 'sat') {
      g.imageSmoothingEnabled = true;
      g.drawImage(bmp, sx, sy, size, size, 0, 0, 256, 256);
    } else {
      // Terrain: decode heights, interpolate bilinearly, re-encode — scaling the colours directly would corrupt them.
      const pc = new OffscreenCanvas(bmp.width, bmp.height); const pg = pc.getContext('2d'); pg.drawImage(bmp, 0, 0);
      const src = pg.getImageData(0, 0, bmp.width, bmp.height).data, W = bmp.width, H = bmp.height;
      const h = (ix, iy) => { ix = Math.max(0, Math.min(W - 1, ix)); iy = Math.max(0, Math.min(H - 1, iy)); const i = (iy * W + ix) * 4; return src[i] * 256 + src[i + 1] + src[i + 2] / 256 - 32768; };
      const out = g.createImageData(256, 256), o = out.data;
      for (let py = 0; py < 256; py++) for (let px = 0; px < 256; px++) {
        const fx = sx + ((px + 0.5) / 256) * size - 0.5, fy = sy + ((py + 0.5) / 256) * size - 0.5;
        const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
        const e = (h(x0, y0) * (1 - tx) + h(x0 + 1, y0) * tx) * (1 - ty) + (h(x0, y0 + 1) * (1 - tx) + h(x0 + 1, y0 + 1) * tx) * ty + 32768;
        const k = (py * 256 + px) * 4; o[k] = Math.floor(e / 256); o[k + 1] = Math.floor(e % 256); o[k + 2] = Math.floor((e % 1) * 256); o[k + 3] = 255;
      }
      g.putImageData(out, 0, 0);
    }
    const blob = await c.convertToBlob({ type: layer === 'sat' ? 'image/jpeg' : 'image/png', quality: 0.9 });
    return new Uint8Array(await blob.arrayBuffer());
  }
  return null;
}

let blankSat, flatDem;
async function placeholder(layer) {
  if (layer === 'sat') {
    if (!blankSat) { const c = new OffscreenCanvas(1, 1); blankSat = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()); }
    return blankSat;
  }
  if (!flatDem) { // terrarium 0 m = rgb(128,0,0)
    const c = new OffscreenCanvas(256, 256); const g = c.getContext('2d'); g.fillStyle = 'rgb(128,0,0)'; g.fillRect(0, 0, 256, 256);
    flatDem = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
  }
  return flatDem;
}

/** MapLibre protocol: rimal://sat/{z}/{x}/{y} and rimal://dem/{z}/{x}/{y} */
export function protocol() {
  return async (params, abort) => {
    const [, , layer, z, x, y] = params.url.split('/');
    const r = await getTile(layer, +z, +x, +y, { signal: abort.signal }).catch(() => null);
    const data = r?.data || (await placeholder(layer));
    return { data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
  };
}

/* ---------------- area download ---------------- */
const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };
export function* tilesIn(bbox, minZ, maxZ) {
  const [w, s, e, n] = bbox;
  for (let z = minZ; z <= maxZ; z++) {
    const x0 = lon2x(w, z), x1 = lon2x(e, z), y0 = lat2y(n, z), y1 = lat2y(s, z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) yield [z, x, y];
  }
}
export function countTiles(bbox, minZ, maxZ) {
  let n = 0; const [w, s, e, nn] = bbox;
  for (let z = minZ; z <= maxZ; z++) n += (lon2x(e, z) - lon2x(w, z) + 1) * (lat2y(s, z) - lat2y(nn, z) + 1);
  return n;
}
export const AVG_BYTES = { sat: 22000, dem: 60000 };

/**
 * Download every tile of an area for offline use. Skips tiles already stored, so it resumes after interruption.
 * Returns { done, failed, bytes }.
 */
export async function downloadArea({ bbox, layers, maxZoom, demMaxZoom = 12, onProgress, signal, force = false }) {
  const jobs = [];
  for (const layer of layers) {
    const top = layer === 'sat' ? Math.min(maxZoom, satSource().maxzoom) : Math.min(demMaxZoom, DEM_SOURCE.maxzoom);
    for (const t of tilesIn(bbox, 0, top)) jobs.push([layer, ...t]);
  }
  let done = 0, failed = 0, bytes = 0, i = 0;
  const total = jobs.length;
  const worker = async () => {
    while (i < jobs.length && !signal?.aborted) {
      const chunk = jobs.slice(i, i + 24); i += 24;
      const keys = chunk.map(([l, z, x, y]) => `${layerKey(l)}/${z}/${x}/${y}`);
      const have = force ? new Set() : await cacheHas(keys);
      for (let k = 0; k < chunk.length && !signal?.aborted; k++) {
        const [l, z, x, y] = chunk[k];
        if (!have.has(keys[k]) && (force || !(await fromPacks(l, z, x, y)))) {
          let ok = false;
          for (let attempt = 0; attempt < 3 && !ok; attempt++) {
            try {
              const d = await netFetch(urlFor(l, z, x, y), signal, 20000);
              if (d) { cachePut(keys[k], d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)); bytes += d.byteLength; }
              ok = true;
            } catch { if (signal?.aborted) break; await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); }
          }
          if (!ok) failed++;
        }
        done++;
        onProgress?.(done / total, { done, total, failed, bytes });
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  await flush();
  return { done, failed, bytes, total, cancelled: !!signal?.aborted };
}

/** Remove a downloaded area's tiles, keeping any that another saved area also needs. */
export async function deleteAreaTiles(area, otherAreas) {
  const keep = (l, z, x, y) => otherAreas.some((o) => o.layers.includes(l) && z <= (l === 'sat' ? o.maxZoom : o.demMaxZoom ?? 12) && inBBox(o.bbox, z, x, y));
  const keys = [];
  for (const l of area.layers) {
    const top = l === 'sat' ? area.maxZoom : area.demMaxZoom ?? 12;
    for (const [z, x, y] of tilesIn(area.bbox, 0, top)) if (!keep(l, z, x, y)) keys.push(`${l === 'sat' ? 'sat:' + area.source : 'dem'}/${z}/${x}/${y}`);
  }
  for (let k = 0; k < keys.length; k += 500) await cacheDelete(keys.slice(k, k + 500));
}
function inBBox(b, z, x, y) { return x >= lon2x(b[0], z) && x <= lon2x(b[2], z) && y >= lat2y(b[3], z) && y <= lat2y(b[1], z); }

/* ---------------- elevation lookup ---------------- */
const demCache = new Map();
export async function elevationAt(lon, lat, z = 12) {
  const x = lon2x(lon, z), y = lat2y(lat, z);
  const k = `${z}/${x}/${y}`;
  let img = demCache.get(k);
  if (img === undefined) {
    const r = await getTile('dem', z, x, y).catch(() => null);
    img = null;
    if (r?.data) {
      const bmp = await createImageBitmap(new Blob([r.data])).catch(() => null);
      if (bmp) { const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0); img = g.getImageData(0, 0, bmp.width, bmp.height); }
    }
    demCache.set(k, img);
    if (demCache.size > 16) demCache.delete(demCache.keys().next().value);
  }
  if (!img) return null;
  const fx = (((lon + 180) / 360) * 2 ** z - x) * img.width;
  const r = (lat * Math.PI) / 180;
  const fy = (((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z - y) * img.height;
  const i = (Math.min(img.height - 1, Math.floor(fy)) * img.width + Math.min(img.width - 1, Math.floor(fx))) * 4;
  const e = img.data[i] * 256 + img.data[i + 1] + img.data[i + 2] / 256 - 32768;
  return e < -500 || e > 9000 ? null : e;
}

export function openPack(file) { return new PMTiles(file); }
