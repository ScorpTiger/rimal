// Persistent storage: IndexedDB for tracks/waypoints/settings, OPFS for big map files.
const DB_NAME = 'rimal';
let dbp;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        const mk = (n, o) => { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, o); };
        mk('tracks', { keyPath: 'id' });     // trips, imported tracks and planned routes
        mk('waypoints', { keyPath: 'id' });
        mk('settings');
        mk('live', { autoIncrement: true });
        mk('mapmeta', { keyPath: 'name' });
        mk('tiles');                          // cached imagery / terrain tiles, key "sat/z/x/y"
        mk('areas', { keyPath: 'id' });       // downloaded areas
        mk('packs', { keyPath: 'pack' });     // installed map packs + versions
        mk('kv');                             // POI index, weather cache, misc
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    const r = fn(s);
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : r);
    t.onerror = () => reject(t.error);
  });
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const getAll = (store) => tx(store, 'readonly', (s) => s.getAll());
export const put = (store, v, key) => tx(store, 'readwrite', (s) => (key === undefined ? s.put(v) : s.put(v, key)));
export const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
export const clear = (store) => tx(store, 'readwrite', (s) => s.clear());
export const getAllKeys = (store) => tx(store, 'readonly', (s) => s.getAllKeys());
export const get = (store, key) => tx(store, 'readonly', (s) => s.get(key));

/* ---- settings ---- */
export const DEFAULTS = {
  units: 'metric',
  coordFormat: 'dd',
  night: false,
  headingUp: false,
  lang: 'en',
  autoRecord: true,
  minPointDist: 8,
  offRouteAlert: 100,
  arrivalRadius: 50,
  satOpacity: 1,
  showSat: true,
  showPois: false,
  showSavedTracks: true,
  showWaypoints: true,
  demoGps: false,
  mapMode: 'hybrid',        // hybrid (satellite + roads/labels) | satellite | topo
  terrain3d: false,
  hillshade: true,
  contours: true,
  satSource: 'eox',
  customSatUrl: '',
  cacheWhileBrowsing: true,
  updateRepo: '',           // "owner/repo" that publishes map packs
  autoUpdate: 'wifi',       // wifi | any | off
  lastUpdateCheck: 0,
  fields: ['heading', 'altitude', 'trip', 'moving', 'ground', 'sunset'],
  fuelRange: 0,             // km on a full tank (0 = off)
  fuelSince: 0,             // odometer metres at last fill-up
  odometer: 0,
  speedAlert: 0,            // km/h (0 = off)
  pitchWarn: 30,
  rollWarn: 25,
  tiltCal: { pitch: 0, roll: 0 },
  sunsetWarn: true,
  showTilt: true,
  showFuelRing: true,
  continueTripId: null,
  autoBase: true,
  updateToken: '',
  lastView: { center: [45.0, 23.8], zoom: 5 },
  baseMap: null,
  satMap: null,
};
export async function loadSettings() {
  const s = { ...DEFAULTS };
  const d = await db();
  await new Promise((resolve) => {
    const t = d.transaction('settings', 'readonly');
    const c = t.objectStore('settings').openCursor();
    c.onsuccess = () => {
      const cur = c.result;
      if (cur) { s[cur.key] = cur.value; cur.continue(); } else resolve();
    };
  });
  return s;
}
export const saveSetting = (k, v) => put('settings', v, k);

/* ---- live recording (crash safe, one row per point) ---- */
export const appendLive = (p) => tx('live', 'readwrite', (s) => s.add(p));
export const liveAll = () => getAll('live');
export const liveClear = () => clear('live');

/* ---- map files in the Origin Private File System ---- */
const hasOPFS = () => !!(navigator.storage && navigator.storage.getDirectory);
const sessionFiles = new Map(); // fallback when OPFS is unavailable

async function mapsDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('maps', { create: true });
}

export async function importMapFile(file, onProgress) {
  const name = file.name.replace(/[^\w.\-]+/g, '_');
  if (!hasOPFS()) {
    sessionFiles.set(name, file);
    return { name, persisted: false };
  }
  try { await navigator.storage.persist?.(); } catch { /* ignore */ }
  const dir = await mapsDir();
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  const CHUNK = 8 * 1024 * 1024;
  try {
    for (let off = 0; off < file.size; off += CHUNK) {
      const buf = await file.slice(off, off + CHUNK).arrayBuffer();
      await w.write(buf);
      onProgress?.(Math.min(1, (off + CHUNK) / file.size));
    }
    await w.close();
  } catch (e) {
    try { await w.abort(); } catch { /* ignore */ }
    await dir.removeEntry(name).catch(() => {});
    // Not enough space or OPFS write failed — use the picked file for this session only.
    sessionFiles.set(name, file);
    return { name, persisted: false, error: e };
  }
  return { name, persisted: true };
}

export async function getMapFile(name) {
  if (sessionFiles.has(name)) return sessionFiles.get(name);
  if (!hasOPFS()) return null;
  try {
    const dir = await mapsDir();
    const fh = await dir.getFileHandle(name);
    const f = await fh.getFile();
    // FileSource uses file.name as cache key
    return f.name === name ? f : new File([f], name);
  } catch { return null; }
}

/** Stream a download into OPFS without holding it in memory. */
export async function writeStreamToOPFS(name, stream, total, onProgress) {
  const dir = await mapsDir();
  const tmp = name + '.part';
  const fh = await dir.getFileHandle(tmp, { create: true });
  const w = await fh.createWritable();
  let got = 0;
  try {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await w.write(value);
      got += value.byteLength;
      onProgress?.(total ? got / total : 0, got);
    }
    await w.close();
  } catch (e) {
    try { await w.abort(); } catch { /* ignore */ }
    await dir.removeEntry(tmp).catch(() => {});
    throw e;
  }
  if (total && got !== total) { await dir.removeEntry(tmp).catch(() => {}); throw new Error(`Download incomplete (${got} of ${total} bytes)`); }
  // Rename .part → final (OPFS has move() on newer engines; fall back to copy).
  const part = await dir.getFileHandle(tmp);
  if (part.move) { await part.move(name); }
  else {
    const f = await part.getFile();
    const out = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await out.write(f); await out.close(); await dir.removeEntry(tmp);
  }
  return got;
}

export async function listMapFiles() {
  const out = new Set(sessionFiles.keys());
  if (hasOPFS()) {
    const dir = await mapsDir();
    for await (const [n] of dir.entries()) if (!n.endsWith('.part')) out.add(n);
  }
  return [...out];
}

export async function deleteMapFile(name) {
  sessionFiles.delete(name);
  if (hasOPFS()) await (await mapsDir()).removeEntry(name).catch(() => {});
  await del('mapmeta', name);
}

export async function storageEstimate() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}
