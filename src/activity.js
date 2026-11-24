// Activity recorder ("flight recorder"): a rolling, on-device log of everything the app does —
// taps, screens opened, GPS quality, map/tile problems, navigation, recording, updates,
// performance and errors — so a problem seen on a drive can be traced afterwards.
// Kept in its own IndexedDB database so it can never slow down or corrupt trips and maps.
const DB = 'rimal-activity';
const KEEP_DAYS = 14;
const KEEP_MAX = 60000;
let dbp, enabled = true, queue = [], flushT = null, seq = 0;
export const session = { id: new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '-' + Math.random().toString(36).slice(2, 5), start: Date.now() };
const counts = { total: 0, error: 0, warn: 0, issue: 0 };

function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { const s = r.result.createObjectStore('ev', { keyPath: 'k' }); s.createIndex('t', 't'); s.createIndex('s', 's'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
function tx(mode, fn) {
  return db().then((d) => new Promise((res, rej) => {
    const t = d.transaction('ev', mode); const out = fn(t.objectStore('ev'));
    t.oncomplete = () => res(out && 'result' in out ? out.result : out); t.onerror = () => rej(t.error);
  }));
}

export function setEnabled(on) { enabled = !!on; }
export const isEnabled = () => enabled;
export const stats = () => ({ ...counts, session: session.id });

// Record one event. type: tap | screen | gps | map | nav | rec | update | perf | app | error | warn | issue | data
export function log(type, msg, data) {
  if (!enabled && type !== 'issue') return;
  counts.total++; if (counts[type] != null) counts[type]++;
  const ev = { k: `${Date.now().toString(36).padStart(9, '0')}-${(seq++).toString(36).padStart(4, '0')}`, t: Date.now(), s: session.id, type, msg: String(msg).slice(0, 300) };
  if (data !== undefined) { try { ev.d = JSON.parse(JSON.stringify(data, (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? +v.toFixed(5) : v))); } catch { /* unserialisable */ } }
  queue.push(ev);
  if (type === 'error' || type === 'issue' || queue.length > 40) flush();
  else if (!flushT) flushT = setTimeout(flush, 4000);
}
export async function flush() {
  clearTimeout(flushT); flushT = null;
  if (!queue.length) return;
  const batch = queue; queue = [];
  try { await tx('readwrite', (s) => { for (const e of batch) s.put(e); }); } catch { /* storage full or blocked: drop silently */ }
}

export async function prune() {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 86400e3;
    await tx('readwrite', (s) => s.index('t').openCursor(IDBKeyRange.upperBound(cutoff)).onsuccess = (e) => { const c = e.target.result; if (c) { c.delete(); c.continue(); } });
    const n = await tx('readonly', (s) => s.count());
    if (n > KEEP_MAX) {
      let drop = n - KEEP_MAX;
      await tx('readwrite', (s) => s.openCursor().onsuccess = (e) => { const c = e.target.result; if (c && drop-- > 0) { c.delete(); c.continue(); } });
    }
  } catch { /* ignore */ }
}

export async function all(sessionId) {
  await flush();
  return tx('readonly', (s) => (sessionId ? s.index('s').getAll(sessionId) : s.getAll()));
}
export async function sessions() {
  const evs = await all();
  const by = new Map();
  for (const e of evs) {
    let x = by.get(e.s);
    if (!x) by.set(e.s, (x = { id: e.s, from: e.t, to: e.t, n: 0, errors: 0, warns: 0, issues: 0, km: 0 }));
    x.to = Math.max(x.to, e.t); x.from = Math.min(x.from, e.t); x.n++;
    if (e.type === 'error') x.errors++; if (e.type === 'warn') x.warns++; if (e.type === 'issue') x.issues++;
  }
  return [...by.values()].sort((a, b) => b.from - a.from);
}
export async function clearAll() { queue = []; await tx('readwrite', (s) => s.clear()); }

// Plain-text export: one line per event, easy to read and easy for Claude to analyse.
export function toText(evs) {
  return evs.map((e) => `${new Date(e.t).toISOString()} [${e.s}] ${e.type.toUpperCase().padEnd(6)} ${e.msg}${e.d !== undefined ? ' ' + JSON.stringify(e.d) : ''}`).join('\n') + '\n';
}

/* ---------- automatic capture ---------- */
const label = (el) => {
  const b = el.closest('button,a,label,.row,.cell,[data-a],.pill,input,select');
  if (!b) return null;
  const id = b.id ? '#' + b.id : '';
  const a = b.dataset?.a ? `[${b.dataset.a}${b.dataset.id ? ':' + b.dataset.id : ''}]` : '';
  const txt = (b.getAttribute('aria-label') || b.title || b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return `${b.tagName.toLowerCase()}${id}${a} "${txt}"`;
};

export function install() {
  // Taps (never the text typed into fields).
  document.addEventListener('click', (e) => { const l = label(e.target); if (l) log('tap', l); }, true);
  document.addEventListener('change', (e) => {
    const el = e.target; if (!el?.tagName) return;
    const v = el.type === 'checkbox' ? el.checked : el.type === 'file' ? `${el.files?.length || 0} file(s)` : '(value)';
    log('tap', `change ${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} = ${v}`);
  }, true);
  // App lifecycle.
  document.addEventListener('visibilitychange', () => { log('app', document.hidden ? 'app hidden (screen off / switched app)' : 'app visible again'); flush(); });
  window.addEventListener('pagehide', () => { log('app', 'page closing'); flush(); });
  window.addEventListener('online', () => log('app', 'network online'));
  window.addEventListener('offline', () => log('app', 'network offline'));
  window.addEventListener('error', (e) => log('error', `uncaught: ${e.message}`, { at: `${(e.filename || '').split('/').pop()}:${e.lineno}:${e.colno}` }));
  window.addEventListener('unhandledrejection', (e) => log('error', `promise: ${e.reason?.message || e.reason}`));
  for (const level of ['error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = (...a) => { try { log(level, a.map((x) => (x instanceof Error ? x.message : typeof x === 'object' ? JSON.stringify(x)?.slice(0, 200) : String(x))).join(' ')); } catch { /* ignore */ } orig(...a); };
  }
  // Freezes: anything that blocks the screen for over 200 ms.
  try {
    new PerformanceObserver((list) => { for (const t of list.getEntries()) if (t.duration > 200) log('perf', `screen blocked ${Math.round(t.duration)} ms`); }).observe({ type: 'longtask', buffered: true });
  } catch { /* not supported */ }
  log('app', 'started', { ua: navigator.userAgent, screen: `${screen.width}x${screen.height}@${devicePixelRatio}`, mem: navigator.deviceMemory, cores: navigator.hardwareConcurrency, online: navigator.onLine });
  setTimeout(prune, 30000);
}

// Periodic health sample (every minute): frame rate over 2 s, memory, battery.
// The frame counter only runs during the 2-second sample so the app can idle the rest of the time.
function sampleFps(ms = 2000) {
  return new Promise((r) => { if (document.hidden) return r(null); let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < ms ? requestAnimationFrame(f) : r(Math.round((n * 1000) / ms)); }; requestAnimationFrame(f); });
}
export function startHeartbeat(extra) {
  let batt = null;
  navigator.getBattery?.().then((b) => { batt = b; }).catch(() => {});
  setInterval(async () => {
    const fps = await sampleFps();
    const d = { fps, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : undefined, battery: batt ? Math.round(batt.level * 100) + (batt.charging ? '+' : '') : undefined, ...(extra?.() || {}) };
    log('perf', `heartbeat ${fps ?? '-'} fps`, d);
  }, 60000);
}
