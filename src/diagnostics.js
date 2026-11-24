// Field-test diagnostics: everything needed to fix a problem reported from a real drive.
const log = [];
const MAX = 300;
function push(level, args) {
  try {
    const msg = args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'object' ? JSON.stringify(a)?.slice(0, 300) : String(a))).join(' ');
    log.push({ t: new Date().toISOString(), level, msg: msg.slice(0, 500) });
    if (log.length > MAX) log.shift();
  } catch { /* ignore */ }
}
// Capture errors and warnings from the moment the app starts.
for (const level of ['error', 'warn']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => { push(level, a); orig(...a); };
}
window.addEventListener('error', (e) => push('uncaught', [e.message, `${e.filename}:${e.lineno}`]));
window.addEventListener('unhandledrejection', (e) => push('promise', [e.reason]));

export const gpsStats = { fixes: 0, accSum: 0, best: Infinity, worst: 0, gaps: 0, lastT: 0, firstFixMs: null, start: performance.now(), errors: [] };
export function noteFix(f) {
  const s = gpsStats;
  if (!s.fixes) s.firstFixMs = Math.round(performance.now() - s.start);
  s.fixes++; s.accSum += f.acc || 0; s.best = Math.min(s.best, f.acc || Infinity); s.worst = Math.max(s.worst, f.acc || 0);
  if (s.lastT && f.t - s.lastT > 5000) s.gaps++;
  s.lastT = f.t;
}
export function noteGpsError(m) { gpsStats.errors.push(`${new Date().toISOString()} ${m}`); if (gpsStats.errors.length > 30) gpsStats.errors.shift(); }

async function frameRate(ms = 2000) {
  return new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < ms ? requestAnimationFrame(f) : r(Math.round((n * 1000) / ms)); }; requestAnimationFrame(f); });
}
function gpu() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) };
  } catch { return { webgl2: false }; }
}

export async function buildReport(app, note) {
  const { state, S, map, tiles, attitude, native } = app;
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const s = gpsStats;
  return {
    report: 'rimal-test-report', version: 2, created: new Date().toISOString(), note: note || '',
    app: { build: typeof __BUILD__ !== 'undefined' ? __BUILD__ : 'dev', native: native.isNative, platform: native.platform },
    device: {
      userAgent: navigator.userAgent, language: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen: `${screen.width}x${screen.height} @${devicePixelRatio}x`, viewport: `${innerWidth}x${innerHeight}`, orientation: screen.orientation?.type,
      cores: navigator.hardwareConcurrency, memoryGB: navigator.deviceMemory, gpu: gpu(), online: navigator.onLine, connection: navigator.connection?.type || navigator.connection?.effectiveType,
    },
    gps: {
      demo: S.demoGps, fixes: s.fixes, firstFixSeconds: s.firstFixMs != null ? +(s.firstFixMs / 1000).toFixed(1) : null,
      avgAccuracyM: s.fixes ? Math.round(s.accSum / s.fixes) : null, bestM: isFinite(s.best) ? s.best : null, worstM: s.worst, gapsOver5s: s.gaps,
      last: state.fix && { lon: +state.fix.lon.toFixed(5), lat: +state.fix.lat.toFixed(5), acc: state.fix.acc, speed: state.fix.speed, heading: state.fix.heading, alt: state.fix.alt },
      errors: s.errors,
    },
    sensors: { motionAvailable: attitude.available, pitch: attitude.pitch, roll: attitude.roll, calibration: attitude.cal ? (attitude.cal.auto ? 'auto' : 'manual') : 'none' },
    maps: {
      files: Object.values(state.maps).map((m) => ({ name: m.name, kind: m.kind, zoom: `${m.minZoom}-${m.maxZoom}`, mb: Math.round(m.size / 1e6) })),
      baseMap: S.baseMap, poiVersion: state.poiVersion, areas: state.areas.map((a) => ({ name: a.name, tiles: a.tiles, failed: a.failed, z: a.maxZoom })),
      cachedTiles: await tiles.cacheStats().catch(() => null), satSource: S.satSource, mode: S.mapMode, terrain3d: S.terrain3d,
      update: { repo: S.updateRepo, policy: S.autoUpdate, lastCheck: S.lastUpdateCheck ? new Date(S.lastUpdateCheck).toISOString() : null, lastError: state.update.lastError || null },
    },
    storage: est ? { usedMB: Math.round(est.usage / 1e6), quotaMB: Math.round(est.quota / 1e6) } : null,
    performance: { startupMs: window.__rimalMarks || null, lite: S.lite, fps: await frameRate(), zoom: +map.getZoom().toFixed(1), jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null, uptimeMin: Math.round(performance.now() / 60000) },
    data: { trips: state.tracks.filter((t) => (t.kind || 'trip') === 'trip').length, routes: state.tracks.filter((t) => t.kind === 'route').length, waypoints: state.waypoints.length, recording: state.rec.active ? state.rec.points.length : 0 },
    settings: { units: S.units, lang: S.lang, night: S.night, fields: S.fields, autoRecord: S.autoRecord },
    log: log.slice(-150),
  };
}

export function summary(r) {
  return [
    `${r.app.platform} · build ${r.app.build}`,
    `Engine: ${(r.device.userAgent.match(/(Chrome|Version)\/[\d.]+/) || ['?'])[0]} · GPU: ${r.device.gpu.renderer || '—'}`,
    `Screen ${r.device.screen} · ${r.performance.fps} fps · map ready ${r.performance.startupMs?.firstIdle ? (r.performance.startupMs.firstIdle / 1000).toFixed(1) + ' s' : '—'}`,
    `GPS: ${r.gps.fixes} fixes · first fix ${r.gps.firstFixSeconds ?? '—'} s · avg ±${r.gps.avgAccuracyM ?? '—'} m · gaps ${r.gps.gapsOver5s}`,
    `Motion sensor: ${r.sensors.motionAvailable ? 'yes' : 'no'} · Maps: ${r.maps.files.length} files · ${r.maps.cachedTiles ?? 0} tiles`,
    `Errors logged: ${r.log.filter((l) => l.level !== 'warn').length} · warnings: ${r.log.filter((l) => l.level === 'warn').length}`,
  ].join('\n');
}
