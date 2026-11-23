import { buildReport, summary as reportSummary, noteFix, noteGpsError } from './diagnostics.js';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol, PMTiles, FileSource, TileType } from 'pmtiles';
import { layers as pmLayers, namedFlavor } from '@protomaps/basemaps';
import mlcontour from 'maplibre-contour';
import './style.css';
import * as store from './storage.js';
import * as tiles from './tiles.js';
import * as packs from './packs.js';
import { GPS } from './gps.js';
import { parseGPX, toGPX } from './gpx.js';
import { native } from './native.js';
import { Attitude, gaugeSVG } from './sensors.js';
import { sunTimes, hhmm, weather, WX, POI_CATS, setPOIs, poiCount, nearest, search as poiSearch, poiGeoJSON, profileSVG } from './extras.js';
import {
  distance, bearing, destination, cardinal, fmtDist, fmtSpeed, speedUnit, fmtAlt, fmtDuration, fmtCoord,
  parseCoord, locateOnRoute, cumulative, pointAlong, pathLength,
} from './geo.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
const TRACK_COLORS = ['#ff5a1f', '#2f9bff', '#c04cff', '#18b37e', '#ffd60a', '#ff3b8d', '#00c2d6'];

let S; // settings
const state = {
  fix: null,
  follow: true,
  tracks: [],      // trips, routes, imports
  waypoints: [],
  areas: [],
  rec: { active: false, paused: false, points: [], segStarts: [0], dist: 0, moving: 0, max: 0, ascent: 0, start: null, continueId: null },
  nav: null,
  maps: {},        // file name -> meta { name, kind: vector|satellite|terrain, version, ... }
  plan: null,      // { mode: 'route'|'measure', points: [] }
  ground: null,    // terrain elevation under the car
  update: { busy: false, msg: '' },
  alerts: {},      // de-duplication of one-shot alerts
  weather: null,
};

/* =========================================================
   Map + data sources
   ========================================================= */
const BASE = location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, '');
maplibregl.setWorkerUrl(`${BASE}maplibre-gl-worker.js`);
const pmProtocol = new Protocol({ metadata: true });
maplibregl.addProtocol('pmtiles', pmProtocol.tile);
maplibregl.addProtocol('rimal', tiles.protocol());

// Contour lines are computed on the device from the same terrain tiles (works offline).
const demSource = new mlcontour.DemSource({ url: 'rimal://dem/{z}/{x}/{y}', encoding: 'terrarium', maxzoom: 12, worker: false });
demSource.manager = new mlcontour.LocalDemManager({
  demUrlPattern: 'rimal://dem/{z}/{x}/{y}', cacheSize: 100, encoding: 'terrarium', maxzoom: 12, timeoutMs: 20000,
  getTile: async (url) => {
    const [, , , z, x, y] = url.split('/');
    const r = await tiles.getTile('dem', +z, +x, +y);
    if (!r) throw new Error('no dem');
    return { data: new Blob([r.data], { type: 'image/png' }) };
  },
});
demSource.setupMaplibre(maplibregl);

let map, meMarker;

function hybridize(lyr) {
  // Keep only roads, borders and labels from the vector map, recoloured to read on top of imagery.
  const out = [];
  for (const l of lyr) {
    if (l.type === 'symbol') {
      out.push({ ...l, paint: { ...l.paint, 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.85)', 'text-halo-width': 1.6 } });
    } else if (l.type === 'line' && (l.id.startsWith('roads') || l.id.startsWith('boundaries'))) {
      if (l.id.includes('rail') || l.id.includes('runway') || l.id.includes('taxiway')) continue;
      const casing = l.id.includes('casing');
      let color = '#f6f1e7';
      if (l.id.includes('highway')) color = '#ffc85c';
      else if (l.id.includes('major')) color = '#ffe8b0';
      else if (l.id.includes('other')) color = '#ffb070';
      else if (l.id.startsWith('boundaries')) color = '#ff9de2';
      out.push({ ...l, paint: { ...l.paint, 'line-color': casing ? 'rgba(0,0,0,0.55)' : color, 'line-opacity': casing ? 0.6 : 0.9 } });
    }
  }
  return out;
}

function buildStyle() {
  const base = S.baseMap && state.maps[S.baseMap] ? S.baseMap : null;
  const satMax = Math.max(tiles.satSource().maxzoom, tiles.packMaxZoom('sat'));
  const sources = {
    sat: { type: 'raster', tiles: ['rimal://sat/{z}/{x}/{y}'], tileSize: 256, maxzoom: satMax, attribution: tiles.satSource().attribution },
    dem: { type: 'raster-dem', tiles: ['rimal://dem/{z}/{x}/{y}'], tileSize: 256, maxzoom: 12, encoding: 'terrarium', attribution: tiles.DEM_SOURCE.attribution },
    dem3d: { type: 'raster-dem', tiles: ['rimal://dem/{z}/{x}/{y}'], tileSize: 256, maxzoom: 12, encoding: 'terrarium' },
    contours: { type: 'vector', tiles: [demSource.contourProtocolUrl({ multiplier: 1, thresholds: { 10: [100, 500], 11: [50, 250], 12: [20, 100], 13: [10, 50], 15: [5, 25] }, elevationKey: 'ele', levelKey: 'level', contourLayer: 'contours' })], maxzoom: 15 },
  };
  let vector = [];
  if (base) {
    sources.protomaps = { type: 'vector', url: `pmtiles://${base}`, attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>' };
    vector = pmLayers('protomaps', namedFlavor(S.night ? 'dark' : 'light'), { lang: S.lang });
    for (const l of vector) {
      if (l.id === 'roads_other') l.paint = { ...l.paint, 'line-color': S.night ? '#a5703f' : '#9a5b22', 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 12, 0.8, 18, 5] };
    }
  }
  const hill = { id: 'hillshade', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': S.mapMode === 'topo' ? 0.5 : 0.25, 'hillshade-shadow-color': '#3b2a18', 'hillshade-highlight-color': '#fff6e5', 'hillshade-illumination-anchor': 'map' } };
  const contourLines = { id: 'contours', type: 'line', source: 'contours', 'source-layer': 'contours', paint: { 'line-color': S.mapMode === 'topo' && !S.night ? 'rgba(120,70,20,0.55)' : 'rgba(255,240,210,0.55)', 'line-width': ['match', ['get', 'level'], 1, 1.3, 0.6] } };
  const contourLabels = { id: 'contour-labels', type: 'symbol', source: 'contours', 'source-layer': 'contours', filter: ['>', ['get', 'level'], 0], layout: { 'symbol-placement': 'line', 'text-size': 11, 'text-field': ['concat', ['number-format', ['get', 'ele'], {}], ' m'], 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': S.mapMode === 'topo' && !S.night ? '#7a4a1c' : '#fff3dc', 'text-halo-color': S.mapMode === 'topo' && !S.night ? '#fff' : '#000', 'text-halo-width': 1 } };
  const satLayer = { id: 'satellite', type: 'raster', source: 'sat', paint: { 'raster-opacity': S.satOpacity, 'raster-fade-duration': 150 } };

  let lyr;
  const bg = { id: 'background', type: 'background', paint: { 'background-color': S.night ? '#141414' : '#2b261f' } };
  if (S.mapMode === 'topo' && base) {
    lyr = vector;
    const at = lyr.findIndex((l) => l.id === 'landuse_pedestrian');
    const extra = [];
    if (S.hillshade) extra.push(hill);
    if (S.contours) extra.push(contourLines);
    lyr.splice(at > 0 ? at : 1, 0, ...extra);
    if (S.contours) lyr.push(contourLabels);
  } else {
    lyr = [bg, satLayer];
    if (S.hillshade) lyr.push(hill);
    if (S.contours) lyr.push(contourLines);
    if (S.mapMode !== 'satellite' && base) lyr.push(...hybridize(vector));
    if (S.contours) lyr.push(contourLabels);
  }

  const empty = { type: 'FeatureCollection', features: [] };
  Object.assign(sources, {
    fuel: { type: 'geojson', data: empty }, saved: { type: 'geojson', data: empty }, plan: { type: 'geojson', data: empty },
    navroute: { type: 'geojson', data: empty }, navline: { type: 'geojson', data: empty }, current: { type: 'geojson', data: empty },
    pois: { type: 'geojson', data: empty }, wpts: { type: 'geojson', data: empty },
  });
  const halo = S.mapMode === 'topo' && !S.night ? '#fff' : '#000';
  const txt = S.mapMode === 'topo' && !S.night ? '#1b1208' : '#fff';
  lyr.push(
    { id: 'fuel', type: 'line', source: 'fuel', paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-dasharray': [3, 2] } },
    { id: 'saved-casing', type: 'line', source: 'saved', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#000', 'line-opacity': 0.4, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 4, 16, 9] } },
    { id: 'saved', type: 'line', source: 'saved', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2.5, 16, 6], 'line-dasharray': ['case', ['==', ['get', 'kind'], 'route'], ['literal', [2, 1]], ['literal', [1, 0]]] } },
    { id: 'plan-line', type: 'line', source: 'plan', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#00e5ff', 'line-width': 4, 'line-dasharray': [2, 1] } },
    { id: 'plan-pts', type: 'circle', source: 'plan', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 8, 'circle-color': '#00e5ff', 'circle-stroke-color': '#000', 'circle-stroke-width': 2 } },
    { id: 'navroute', type: 'line', source: 'navroute', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ff00d4', 'line-opacity': 0.75, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 5, 16, 12] } },
    { id: 'navline', type: 'line', source: 'navline', paint: { 'line-color': '#ff00d4', 'line-width': 3, 'line-dasharray': [2, 2] } },
    { id: 'current-casing', type: 'line', source: 'current', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fff', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 5, 16, 10] } },
    { id: 'current', type: 'line', source: 'current', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#e5000b', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 16, 6] } },
    { id: 'rimal-pois', type: 'circle', source: 'pois', minzoom: 9, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3, 15, 7], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } },
    { id: 'rimal-pois-label', type: 'symbol', source: 'pois', minzoom: 12, layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [0, 1], 'text-anchor': 'top', 'text-optional': true }, paint: { 'text-color': txt, 'text-halo-color': halo, 'text-halo-width': 1.5 } },
    { id: 'wpts-alert', type: 'circle', source: 'wpts', filter: ['>', ['get', 'alert'], 0], paint: { 'circle-radius': 14, 'circle-color': 'rgba(229,72,77,0.25)', 'circle-stroke-color': '#e5484d', 'circle-stroke-width': 2 } },
    { id: 'wpts', type: 'circle', source: 'wpts', paint: { 'circle-radius': 9, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } },
    { id: 'wpts-label', type: 'symbol', source: 'wpts', layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Medium'], 'text-size': 15, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-optional': true }, paint: { 'text-color': txt, 'text-halo-color': halo, 'text-halo-width': 2 } },
  );
  return { version: 8, glyphs: `${BASE}assets/fonts/{fontstack}/{range}.pbf`, sprite: `${BASE}assets/sprites/${S.night ? 'dark' : 'light'}`, sources, layers: lyr };
}

function applyStyle() {
  map.setStyle(buildStyle(), { diff: false });
  map.once('style.load', () => { applyTerrain(); refreshOverlays(); });
  updateNoMapHint();
}
function applyTerrain() {
  if (!map.isStyleLoaded()) return void map.once('idle', applyTerrain);
  if (S.terrain3d) { map.setTerrain({ source: 'dem3d', exaggeration: 1.5 }); if (map.getPitch() < 30) map.easeTo({ pitch: 60 }); }
  else { map.setTerrain(null); if (map.getPitch() > 0) map.easeTo({ pitch: 0 }); }
  $('b3d').classList.toggle('on', !!S.terrain3d);
}
function updateNoMapHint() {
  if (!state.engineOk) return;
  const any = Object.keys(state.maps).length || state.areas.length;
  $('noMap').hidden = !!any || tiles.isOnline();
}

const src = (id) => map.getSource(id);
const fc = (features) => ({ type: 'FeatureCollection', features });
const line = (coords, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords.map((c) => [c[0], c[1]]) } });
function trackFeature(t) {
  const starts = t.segStarts && t.segStarts.length > 1 ? t.segStarts : null;
  if (!starts) return line(t.coords, { color: t.color, id: t.id, kind: t.kind || 'trip' });
  const parts = starts.map((s, i) => t.coords.slice(s, starts[i + 1] ?? t.coords.length).map((c) => [c[0], c[1]])).filter((p) => p.length > 1);
  return { type: 'Feature', properties: { color: t.color, id: t.id, kind: t.kind || 'trip' }, geometry: { type: 'MultiLineString', coordinates: parts } };
}
function circle(center, radius, n = 96) { const c = []; for (let i = 0; i <= n; i++) c.push(destination(center, (i * 360) / n, radius)); return c; }

function refreshOverlays() {
  if (!src('saved')) return;
  src('saved').setData(fc(S.showSavedTracks ? state.tracks.filter((t) => t.visible !== false).map(trackFeature) : []));
  const r = state.rec;
  src('current').setData(fc(r.points.length > 1 ? [line(r.points)] : []));
  src('wpts').setData(fc(S.showWaypoints ? state.waypoints.map((w) => ({ type: 'Feature', properties: { id: w.id, name: w.name, color: w.color || '#e8a33d', alert: w.alertRadius || 0 }, geometry: { type: 'Point', coordinates: [w.lon, w.lat] } })) : []));
  src('navroute').setData(fc(state.nav?.route ? [line(state.nav.route)] : []));
  src('pois').setData(S.showPois ? poiGeoJSON() : fc([]));
  refreshPlan(); refreshFuelRing(); updateNavLine();
}
function updateNavLine() {
  const f = state.fix, n = state.nav;
  src('navline')?.setData(fc(f && n ? [line([[f.lon, f.lat], n.aim || n.target])] : []));
}

/* =========================================================
   Map files & packs (offline, versioned)
   ========================================================= */
async function registerMap(name) {
  const file = await store.getMapFile(name);
  if (!file) return null;
  const pm = new PMTiles(new FileSource(file));
  const h = await pm.getHeader();
  let md = {};
  try { md = (await pm.getMetadata()) || {}; } catch { /* none */ }
  let kind = packs.kindOfFile(name, md);
  if (!kind) kind = h.tileType === TileType.Mvt ? 'vector' : md.encoding === 'terrarium' ? 'terrain' : 'satellite';
  if (kind === 'map') kind = 'vector';
  if (h.tileType === TileType.Mvt) pmProtocol.add(pm);
  const meta = { name, kind, version: packs.versionOf(name), minZoom: h.minZoom, maxZoom: h.maxZoom, bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat], size: file.size, pm };
  state.maps[name] = meta;
  return meta;
}

async function loadMaps() {
  state.maps = {};
  for (const n of await store.listMapFiles()) {
    if (n.endsWith('.json')) continue;
    try { await registerMap(n); } catch (e) { console.warn('Map file unreadable, skipping', n, e); }
  }
  const byNewest = (k) => Object.values(state.maps).filter((m) => m.kind === k).sort((a, b) => b.version.localeCompare(a.version));
  // Vector base: the user's choice if it still opens, else the newest, else the previous (automatic fallback).
  const vec = byNewest('vector');
  if (!S.baseMap || !state.maps[S.baseMap] || S.autoBase !== false) S.baseMap = vec[0]?.name || null;
  tiles.setPacks('sat', byNewest('satellite').map((m) => ({ name: m.name, pm: m.pm, minZoom: m.minZoom, maxZoom: m.maxZoom })));
  tiles.setPacks('dem', byNewest('terrain').map((m) => ({ name: m.name, pm: m.pm, minZoom: m.minZoom, maxZoom: m.maxZoom })));
  const poi = await packs.latestPOI();
  setPOIs(poi?.data || []);
  state.poiVersion = poi?.version || null;
}

/* ---------- automatic updates ---------- */
async function checkUpdates(manual = false) {
  if (state.update.busy) return manual && toast('Already updating…');
  if (!S.updateRepo) { if (manual) toast('Set the map update source first (Maps → Updates)'); return; }
  if (!manual && !packs.connectionOk(S.autoUpdate)) return;
  if (manual) tiles.resetOnline();
  if (!tiles.isOnline()) { if (manual) toast('No internet — keeping your current offline maps'); return; }
  state.update.busy = true; setUpdateMsg('Checking for map updates…');
  try {
    const remote = await packs.listRemote(S.updateRepo, S.updateToken);
    S.lastUpdateCheck = Date.now(); store.saveSetting('lastUpdateCheck', S.lastUpdateCheck);
    state.remote = remote;
    const installed = installedVersions();
    const todo = Object.values(remote).filter((r) => !installed[r.kind] || installed[r.kind][0] < r.version);
    if (!todo.length) { setUpdateMsg(''); if (manual) toast('Maps are up to date'); return; }
    let changed = false;
    for (const item of todo) {
      const label = packs.KINDS[item.kind];
      try {
        setUpdateMsg(`Downloading ${label} (${item.version})…`);
        const file = await packs.download(item, S.updateToken, (p) => setUpdateMsg(`Updating ${label}: ${Math.round(p * 100)}%`));
        if (item.kind !== 'poi') {
          const meta = await registerMap(file).catch(() => null);
          if (!meta) { await store.deleteMapFile(file); throw new Error('the downloaded file is damaged'); }
        }
        changed = true;
        toast(`${label} updated to ${fmtVer(item.version)} — previous version kept as backup`, 5000);
      } catch (e) {
        console.warn('Update failed', item.kind, e?.message || e);
        state.update.lastError = `${item.kind}: ${e?.message || e}`;
        toast(`${label} update failed (${e.message}). Your current version is still in use.`, 6000);
      }
    }
    if (changed) {
      await packs.prune(Object.values(state.maps).map((m) => ({ name: m.name, kind: m.kind })));
      await loadMaps(); applyStyle();
    }
  } catch (e) {
    console.warn('Update check failed', e?.message || e);
    state.update.lastError = String(e?.message || e);
    if (manual) toast(`Update check failed: ${e.message}`, 6000);
  } finally { state.update.busy = false; setUpdateMsg(''); if (!$('sheet').hidden && $('sheetTitle').textContent === 'Maps & layers') mapsSheet(); }
}
function installedVersions() {
  const v = {};
  for (const m of Object.values(state.maps)) { const k = m.kind === 'vector' ? 'map' : m.kind; (v[k] ||= []).push(m.version); }
  if (state.poiVersion) v.poi = [state.poiVersion];
  for (const k in v) v[k].sort().reverse();
  return v;
}
const fmtVer = (v) => (v && v !== '00000000' ? `${v.slice(6, 8)}/${v.slice(4, 6)}/${v.slice(0, 4)}` : 'imported');
function setUpdateMsg(m) { state.update.msg = m; const el = $('updState'); el.textContent = m; el.hidden = !m; }

/* =========================================================
   GPS, dashboard, sensors
   ========================================================= */
const gps = new GPS(onFix, (msg) => { noteGpsError(msg); setGpsPill(msg.includes('denied') ? 'NO PERMISSION' : 'NO GPS', ''); if (msg.includes('denied')) toast(msg); });
const attitude = new Attitude(onAttitude);
let staleTimer, lastGroundAt = 0, lastOdo = null;

function setGpsPill(text, cls) { const p = $('gpsState'); p.textContent = text; p.className = 'pill ' + cls; }

function onFix(f) {
  noteFix(f);
  const wasFirst = !state.fix;
  state.fix = f;
  clearTimeout(staleTimer);
  staleTimer = setTimeout(() => { setGpsPill('GPS LOST', ''); meMarker?.getElement().classList.add('stale'); }, 12000);
  meMarker?.getElement().classList.remove('stale');
  setGpsPill(S.demoGps ? 'DEMO GPS' : f.acc <= 20 ? 'GPS OK' : 'GPS WEAK', S.demoGps ? 'weak' : f.acc <= 20 ? 'ok' : 'weak');

  if (!meMarker) {
    const el = document.createElement('div');
    el.className = 'me';
    el.innerHTML = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" fill="rgba(47,155,255,.22)"/><path d="M50 8 L80 84 L50 66 L20 84 Z" fill="#2f9bff" stroke="#fff" stroke-width="6" stroke-linejoin="round"/></svg>';
    meMarker = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat([f.lon, f.lat]).addTo(map);
  }
  meMarker.setLngLat([f.lon, f.lat]);
  if (f.heading != null) meMarker.setRotation(f.heading);

  // Odometer runs all the time (fuel range), not only while recording.
  if (f.acc <= 60) {
    if (lastOdo) { const d = distance(lastOdo, [f.lon, f.lat]); if (d > 5 && d < 2000) { S.odometer += d; lastOdo = [f.lon, f.lat]; } }
    else lastOdo = [f.lon, f.lat];
  }
  if (Date.now() - lastGroundAt > 5000) {
    lastGroundAt = Date.now();
    tiles.elevationAt(f.lon, f.lat).then((e) => { state.ground = e; }).catch(() => {});
  }

  recordFix(f);
  navigate(f);
  checkAlerts(f);
  updateDash();

  if (state.follow) {
    const opts = { center: [f.lon, f.lat], duration: 900, easing: (t) => t };
    if (wasFirst && map.getZoom() < 13) { opts.zoom = 15; opts.duration = 0; }
    if (S.headingUp && f.heading != null) { opts.bearing = f.heading; opts.padding = { top: map.getContainer().clientHeight * 0.35, bottom: 0, left: 0, right: 0 }; }
    else opts.padding = { top: 0, bottom: 0, left: 0, right: 0 };
    map.easeTo(opts);
  }
  if (wasFirst) setTimeout(() => refreshWeather(), 3000);
}

/* ---- configurable data fields ---- */
const FIELDS = {
  heading: { label: 'Heading', v: (f) => (f?.heading != null ? `${Math.round(f.heading)}° ${cardinal(f.heading)}` : '—') },
  altitude: { label: 'Altitude', v: (f) => fmtAlt(f?.alt, S.units) },
  ground: { label: 'Ground elev', v: () => fmtAlt(state.ground, S.units) },
  trip: { label: 'Trip', v: () => fmtDist(state.rec.dist, S.units) },
  moving: { label: 'Moving time', v: () => fmtDuration(state.rec.moving) },
  avg: { label: 'Avg moving', v: () => `${fmtSpeed(state.rec.moving > 0 ? state.rec.dist / state.rec.moving : null, S.units)} ${speedUnit(S.units)}` },
  max: { label: 'Max speed', v: () => `${fmtSpeed(state.rec.max, S.units)} ${speedUnit(S.units)}` },
  odo: { label: 'Odometer', v: () => fmtDist(S.odometer, S.units) },
  acc: { label: 'GPS accuracy', v: (f) => (f ? `±${fmtDist(f.acc, S.units)}` : '—') },
  time: { label: 'Time', v: () => hhmm(new Date()) },
  sunrise: { label: 'Sunrise', v: (f) => (f ? hhmm(sunTimes(f.lon, f.lat).sunrise) : '—') },
  sunset: { label: 'Sunset', v: (f) => { if (!f) return '—'; const s = sunTimes(f.lon, f.lat).sunset; const left = (s - Date.now()) / 1000; return left > 0 && left < 4 * 3600 ? `${hhmm(s)} (${fmtDuration(left)})` : hhmm(s); } },
  pitch: { label: 'Pitch', v: () => (attitude.pitch == null ? '—' : `${Math.round(attitude.pitch)}°`) },
  roll: { label: 'Roll', v: () => (attitude.roll == null ? '—' : `${Math.round(attitude.roll)}°`) },
  fuel: { label: 'Fuel range', v: () => (S.fuelRange ? fmtDist(fuelLeft(), S.units) : 'set up') },
  dest: { label: 'To target', v: () => (state.nav ? $('navDist').textContent : '—') },
  eta: { label: 'ETA', v: () => (state.nav ? $('navEta').textContent : '—') },
  temp: { label: 'Temp', v: () => { const c = state.weather?.data?.current; return c ? `${Math.round(c.temperature_2m)}°C` : '—'; } },
  wind: { label: 'Wind / gusts', v: () => { const c = state.weather?.data?.current; return c ? `${Math.round(c.wind_speed_10m)}/${Math.round(c.wind_gusts_10m)} km/h` : '—'; } },
  coords: { label: 'Position', v: (f) => (f ? fmtCoord(f.lon, f.lat, 'dd').replace(', ', ' ') : '—') },
};

function renderFields() {
  $('fields').innerHTML = S.fields.map((k, i) => `<button class="cell" data-slot="${i}"><label>${FIELDS[k]?.label || '—'}</label><b id="fv${i}">—</b></button>`).join('');
}
function updateDash() {
  const f = state.fix, u = S.units, r = state.rec;
  $('dSpeed').textContent = f ? fmtSpeed(f.speed, u) : '—';
  $('dSpeedUnit').textContent = speedUnit(u);
  S.fields.forEach((k, i) => { const el = $('fv' + i); if (el) el.textContent = FIELDS[k] ? FIELDS[k].v(f) : '—'; });
  $('dCoord').textContent = f ? fmtCoord(f.lon, f.lat, S.coordFormat) : '—';
  const rs = $('recState');
  rs.className = 'rec ' + (r.active ? (r.paused ? 'paused' : 'on') : 'idle');
  const tripName = r.continueId ? state.tracks.find((t) => t.id === r.continueId)?.name : null;
  rs.textContent = r.active ? (r.paused ? `Paused · ${fmtDist(r.dist, u)}` : `● ${tripName ? 'Continuing ' + tripName : 'Recording trip'} · ${fmtDist(r.dist, u)}`) : 'Not recording';
  $('bRec').classList.toggle('active', r.active && !r.paused);
  $('bRec').querySelector('span').textContent = r.active ? (r.paused ? 'Resume' : 'Trip ●') : 'Record';
}
function fieldPicker(slot) {
  openSheet('Choose data field', `<div class="chips">${Object.entries(FIELDS).map(([k, d]) => `<button class="btn ${S.fields[slot] === k ? 'primary' : ''}" data-a="pick" data-id="${k}">${d.label}</button>`).join('')}</div>`, {
    pick: (id) => { S.fields[slot] = id; store.saveSetting('fields', S.fields); renderFields(); updateDash(); closeSheet(); },
  });
}

/* ---- pitch & roll ---- */
let lastTiltBeep = 0;
function onAttitude(a) {
  $('tilt').hidden = !S.showTilt;
  $('tiltPitch').innerHTML = gaugeSVG(a.pitch, 'side', S.pitchWarn);
  $('tiltRoll').innerHTML = gaugeSVG(a.roll, 'rear', S.rollWarn);
  const bad = (a.pitch != null && Math.abs(a.pitch) >= S.pitchWarn) || (a.roll != null && Math.abs(a.roll) >= S.rollWarn);
  $('tilt').classList.toggle('warn', bad);
  if (bad && Date.now() - lastTiltBeep > 4000) { lastTiltBeep = Date.now(); beep(1, 1200); }
}
function tiltSheet() {
  const avail = attitude.available;
  openSheet('Pitch & roll', `
    <div class="gauges"><div>${gaugeSVG(attitude.pitch, 'side', S.pitchWarn)}<p>Pitch (nose up/down)</p></div><div>${gaugeSVG(attitude.roll, 'rear', S.rollWarn)}<p>Roll (side tilt)</p></div></div>
    ${avail ? '' : '<p class="note">No motion sensor reported by this head unit yet. If your unit has one, readings appear here automatically; otherwise pitch & roll need a phone-based or external sensor.</p>'}
    <p class="note">${attitude.cal?.auto ? 'Level was set automatically when Rimal started. ' : ''}Park on level ground and press <b>Calibrate</b> so the unit’s mounting angle reads as 0°. Works with the screen upright, tilted or flat.</p>
    <div class="btns" style="margin-bottom:14px"><button class="primary" data-a="cal">Calibrate (set level)</button><button class="btn" data-a="toggle">${S.showTilt ? 'Hide' : 'Show'} gauges on map</button></div>
    <div class="field"><label>Pitch warning</label>${segHtml('pitchWarn', [[20, '20°'], [25, '25°'], [30, '30°'], [35, '35°'], [40, '40°']])}</div>
    <div class="field"><label>Roll warning</label>${segHtml('rollWarn', [[15, '15°'], [20, '20°'], [25, '25°'], [30, '30°'], [35, '35°']])}</div>`, {
    cal: () => { if (!attitude.available) return toast('No motion sensor readings yet'); S.tiltCal = attitude.calibrate(); store.saveSetting('tiltCal', S.tiltCal); toast('Level set — this mounting now reads 0°'); tiltSheet(); },
    toggle: () => { setS('showTilt', !S.showTilt); $('tilt').hidden = !S.showTilt; tiltSheet(); },
    set: (id) => { const [k, v] = id.split(':'); setS(k, +v); tiltSheet(); },
  });
}

/* ---- alerts: speed, fuel, waypoint proximity, sunset ---- */
function once(key, ms = 600000) { const t = state.alerts[key]; if (t && Date.now() - t < ms) return false; state.alerts[key] = Date.now(); return true; }
function checkAlerts(f) {
  const kmh = (f.speed || 0) * 3.6;
  if (S.speedAlert && kmh > S.speedAlert + 2 && once('speed', 30000)) { alertBar(`SPEED ${Math.round(kmh)} km/h (limit ${S.speedAlert})`); beep(2); setTimeout(hideAlert, 5000); }
  for (const w of state.waypoints) {
    if (!w.alertRadius) continue;
    const d = distance([f.lon, f.lat], [w.lon, w.lat]);
    if (d < w.alertRadius && once('wp' + w.id, 15 * 60000)) { alertBar(`⚠ ${w.name} — ${fmtDist(d, S.units)} ahead`); beep(3); setTimeout(hideAlert, 9000); }
  }
  if (S.fuelRange) {
    const left = fuelLeft();
    const fuel = nearest([f.lon, f.lat], 'fuel', 1)[0];
    const need = fuel ? fuel[0] * 1.3 : null;
    if ((left < 60000 || (need && left < need + 20000)) && once('fuel', 20 * 60000)) {
      alertBar(`⛽ LOW RANGE · ${fmtDist(left, S.units)} left${fuel ? ` · nearest fuel ${fmtDist(fuel[0], S.units)}` : ''}`); beep(2); setTimeout(hideAlert, 10000);
    }
    refreshFuelRing();
  }
  if (S.sunsetWarn) {
    const s = sunTimes(f.lon, f.lat).sunset, left = s - Date.now();
    if (left > 0 && left < 45 * 60000 && once('sunset' + new Date().toDateString(), 86400000)) { alertBar(`☀ Sunset in ${Math.round(left / 60000)} min (${hhmm(s)})`, true); setTimeout(hideAlert, 8000); }
  }
}
const fuelLeft = () => Math.max(0, S.fuelRange * 1000 - (S.odometer - S.fuelSince));
function refreshFuelRing() {
  if (!src('fuel')) return;
  if (!S.fuelRange || !state.fix || !S.showFuelRing) return src('fuel').setData(fc([]));
  const c = [state.fix.lon, state.fix.lat], left = fuelLeft();
  src('fuel').setData(fc([line(circle(c, left / 2), { color: '#ffb020' }), line(circle(c, left), { color: '#e5484d' })]));
}
function fuelSheet() {
  const f = state.fix;
  const near = f ? nearest([f.lon, f.lat], 'fuel', 6) : [];
  openSheet('Fuel range', `
    <div class="field"><label>Range on a full tank</label><input type="number" id="fRange" inputmode="numeric" placeholder="e.g. 650" value="${S.fuelRange || ''}"></div>
    <div class="btns" style="margin-bottom:12px"><button class="primary" data-a="save">Save</button><button class="btn" data-a="fill">⛽ I just filled up</button><button class="btn" data-a="ring">${S.showFuelRing ? 'Hide' : 'Show'} range rings</button></div>
    ${S.fuelRange ? `<p><b>${fmtDist(fuelLeft(), S.units)}</b> left since last fill-up (${fmtDist(S.odometer - S.fuelSince, S.units)} driven). The orange ring is your <b>turn-back radius</b> (half the range), red is the full range — both as the crow flies.</p>` : '<p class="note">Enter your tank range to get a low-fuel alert, the distance to the nearest station, and point-of-no-return rings.</p>'}
    <h3>Nearest fuel</h3>
    ${near.length ? near.map(([d, p], i) => `<div class="row"><div class="grow"><div class="title">${esc(p[3] || p[4] || 'Fuel station')}</div><div class="sub">${fmtDist(d, S.units)} · ${Math.round(bearing([f.lon, f.lat], p))}°</div></div><button class="primary" data-a="go" data-id="${i}">➤</button></div>`).join('') : `<div class="empty">${poiCount() ? 'No fuel stations in the POI pack nearby' : 'Install the Places & POIs pack (Maps → Updates) to find fuel offline'}</div>`}`, {
    save: () => { setS('fuelRange', +$('fRange').value || 0); if (!S.fuelSince) setS('fuelSince', S.odometer); refreshFuelRing(); fuelSheet(); },
    fill: () => { setS('fuelSince', S.odometer); toast('Fuel range reset to full'); refreshFuelRing(); fuelSheet(); },
    ring: () => { setS('showFuelRing', !S.showFuelRing); refreshFuelRing(); fuelSheet(); },
    go: (i) => { const p = near[+i][1]; closeSheet(); startGoto([p[0], p[1]], p[3] || 'Fuel'); },
  });
}

/* =========================================================
   Trips (track recording)
   ========================================================= */
function recordFix(f) {
  const r = state.rec;
  if (f.acc > 60) return;
  if (r.autoHold && f.speed < 0.5) r.autoHold = false;
  if (!r.active && S.autoRecord && !r.autoHold && f.speed > 2.5) startRecording(true);
  if (!r.active || r.paused) return;
  const p = [+f.lon.toFixed(7), +f.lat.toFixed(7), f.alt != null ? +f.alt.toFixed(1) : null, f.t];
  const last = r.points[r.points.length - 1];
  if (last) {
    const d = distance(last, p);
    const dt = (p[3] - last[3]) / 1000;
    if (d < S.minPointDist && dt < 30) return;
    if (dt > 0 && d / dt > 90) return; // GPS glitch
    r.dist += d;
    if (f.speed > 0.8 && dt < 120) r.moving += dt;
    if (p[2] != null && last[2] != null && p[2] > last[2]) r.ascent += p[2] - last[2];
  }
  if (f.speed > r.max && f.speed < 90) r.max = f.speed;
  r.points.push(p);
  store.appendLive({ p, stats: { dist: r.dist, moving: r.moving, max: r.max, ascent: r.ascent, start: r.start, continueId: r.continueId } });
  src('current')?.setData(fc(r.points.length > 1 ? [line(r.points)] : []));
}

function startRecording(auto = false, continueId = null) {
  if (auto && S.continueTripId && state.tracks.some((t) => t.id === S.continueTripId)) continueId = S.continueTripId;
  Object.assign(state.rec, { active: true, paused: false, points: [], dist: 0, moving: 0, max: 0, ascent: 0, start: Date.now(), continueId });
  const t = continueId && state.tracks.find((x) => x.id === continueId);
  toast(t ? `Continuing trip “${t.name}”` : auto ? 'Movement detected — recording a new trip' : 'Trip recording started');
  updateDash();
}

async function stopRecording() {
  const r = state.rec;
  if (r.points.length < 2) {
    Object.assign(r, { active: false, paused: false, points: [], autoHold: true });
    await store.liveClear(); refreshOverlays(); updateDash();
    return toast('Trip too short — discarded');
  }
  const stats = { dist: r.dist, moving: r.moving, max: r.max, ascent: r.ascent, duration: (r.points.at(-1)[3] - r.points[0][3]) / 1000 };
  const existing = r.continueId && state.tracks.find((t) => t.id === r.continueId);
  let t;
  if (existing) {
    t = existing;
    t.segStarts = t.segStarts || [0];
    t.segStarts.push(t.coords.length);
    t.coords = t.coords.concat(r.points);
    const s = t.stats || {};
    t.stats = { dist: (s.dist || 0) + stats.dist, moving: (s.moving || 0) + stats.moving, max: Math.max(s.max || 0, stats.max), ascent: (s.ascent || 0) + stats.ascent, duration: (s.duration || 0) + stats.duration };
    t.end = Date.now();
  } else {
    const d = new Date(r.start || r.points[0][3] || Date.now());
    const name = await prompt('Save trip', 'Trip name', `Trip ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`);
    if (name === null) return;
    t = { id: store.uid(), kind: 'trip', name: name || 'Trip', created: r.start || Date.now(), end: Date.now(), coords: r.points, segStarts: [0], stats, notes: '', color: TRACK_COLORS[state.tracks.length % TRACK_COLORS.length], visible: true };
    state.tracks.push(t);
  }
  await store.put('tracks', t);
  Object.assign(r, { active: false, paused: false, points: [], dist: 0, moving: 0, max: 0, ascent: 0, autoHold: true, continueId: null });
  await store.liveClear();
  refreshOverlays(); updateDash();
  toast(`Trip “${t.name}” saved · ${fmtDist(t.stats.dist, S.units)}`, 4000);
}

async function restoreLive() {
  const rows = await store.liveAll();
  if (!rows.length) return;
  const last = rows.at(-1).stats;
  Object.assign(state.rec, { active: true, paused: false, points: rows.map((x) => x.p), ...last });
  toast(`Resumed unsaved trip (${rows.length} points)`);
}

function recMenu() {
  const r = state.rec;
  if (!r.active) {
    const recent = [...state.tracks].filter((t) => (t.kind || 'trip') === 'trip').sort((a, b) => (b.end || b.created) - (a.end || a.created)).slice(0, 3);
    if (!recent.length) return startRecording();
    return openSheet('Start recording', `
      <div class="btns" style="margin-bottom:12px"><button class="primary" data-a="new">● New trip</button></div>
      <p class="note">…or add today’s driving to an existing trip (multi-day expeditions):</p>
      ${recent.map((t) => `<div class="row"><div class="swatch" style="background:${t.color}"></div><div class="grow"><div class="title">${esc(t.name)}</div><div class="sub">${new Date(t.end || t.created).toLocaleString()} · ${fmtDist(t.stats?.dist, S.units)}</div></div><button class="btn" data-a="cont" data-id="${t.id}">Continue</button></div>`).join('')}`, {
      new: () => { closeSheet(); startRecording(); },
      cont: (id) => { closeSheet(); startRecording(false, id); },
    });
  }
  openSheet('Trip recording', `
    <p class="note">${r.points.length} points · ${fmtDist(r.dist, S.units)} · moving ${fmtDuration(r.moving)}</p>
    <div class="btns">
      <button class="primary" data-a="pause">${r.paused ? '▶ Resume' : '❚❚ Pause'}</button>
      <button class="btn" data-a="save">■ Stop &amp; save trip</button>
      <button class="btn danger" data-a="discard">Discard</button>
    </div>`, {
    pause: () => { r.paused = !r.paused; closeSheet(); updateDash(); },
    save: () => { closeSheet(); stopRecording(); },
    discard: async () => {
      if (!(await confirmBox('Discard the current recording? This cannot be undone.'))) return;
      Object.assign(r, { active: false, paused: false, points: [], autoHold: true, continueId: null }); await store.liveClear(); closeSheet(); refreshOverlays(); updateDash();
    },
  });
}

/* =========================================================
   Navigation
   ========================================================= */
function navZoom() { if (state.fix && map.getZoom() < 13) map.easeTo({ center: [state.fix.lon, state.fix.lat], zoom: 15, duration: 500 }); }

function startGoto(target, name) {
  navZoom();
  state.nav = { kind: 'goto', name, target, arrived: false };
  $('navBar').hidden = false; $('navOffWrap').hidden = true;
  refreshOverlays();
  if (state.fix) navigate(state.fix); else toast('Navigation set — waiting for GPS');
  state.follow = true; $('bFollow').classList.add('on');
}
function startRoute(coords, name, reverse, label) {
  let route = coords.map((c) => [c[0], c[1]]);
  if (reverse) route = route.reverse();
  const thin = [route[0]];
  for (const p of route) if (distance(thin.at(-1), p) >= 5) thin.push(p);
  if (thin.at(-1) !== route.at(-1)) thin.push(route.at(-1));
  state.nav = { kind: 'route', name: (label || (reverse ? 'TrackBack: ' : 'Follow: ')) + name, route: thin, cum: cumulative(thin), target: thin.at(-1), hint: null, arrived: false, offAlerted: false };
  $('navBar').hidden = false; $('navOffWrap').hidden = false;
  refreshOverlays();
  navZoom();
  if (state.fix) navigate(state.fix); else map.fitBounds(bbox(thin), { padding: 60, duration: 600 });
  state.follow = true; $('bFollow').classList.add('on');
}
function stopNav() { state.nav = null; $('navBar').hidden = true; hideAlert(); refreshOverlays(); }

function navigate(f) {
  const n = state.nav;
  if (!n) return;
  const me = [f.lon, f.lat];
  let dist, aim, off = null;
  if (n.kind === 'goto') { dist = distance(me, n.target); aim = n.target; }
  else {
    const loc = locateOnRoute(me, n.route, n.cum, n.hint);
    n.hint = loc.segment; off = loc.offRoute;
    dist = loc.remaining + (off > 30 ? off : 0);
    const look = Math.max(60, (f.speed || 0) * 8);
    aim = off > 150 ? loc.point : pointAlong(n.route, n.cum, loc.along + look);
    $('navOff').textContent = fmtDist(off, S.units);
    $('navOff').style.color = off > S.offRouteAlert ? 'var(--danger)' : '';
    if (off > S.offRouteAlert && !n.offAlerted) { n.offAlerted = true; alertBar(`OFF TRACK · ${fmtDist(off, S.units)}`); beep(2); }
    else if (off < S.offRouteAlert * 0.6 && n.offAlerted) { n.offAlerted = false; hideAlert(); }
  }
  n.aim = aim; n.dist = dist;
  const brg = bearing(me, aim);
  const rel = f.heading != null ? brg - f.heading : brg - map.getBearing();
  $('navArrowSvg').style.transform = `rotate(${rel}deg)`;
  $('navName').textContent = n.name;
  $('navDist').textContent = fmtDist(dist, S.units);
  $('navBrg').textContent = `${Math.round(brg)}° ${cardinal(brg)}`;
  const spd = f.speed > 1.5 ? f.speed : null;
  $('navEta').textContent = spd ? fmtDuration(dist / spd) : '—';
  if (!n.arrived && distance(me, n.target) < S.arrivalRadius && (n.kind === 'goto' || n.cum.at(-1) - (n.cum[n.hint] || 0) < S.arrivalRadius * 3)) {
    n.arrived = true; alertBar(`ARRIVED · ${n.name}`, true); beep(3); setTimeout(hideAlert, 8000);
  }
  updateNavLine();
}

function alertBar(text, ok = false) { const a = $('alertBar'); a.textContent = text; a.className = ok ? 'ok' : ''; a.hidden = false; }
function hideAlert() { $('alertBar').hidden = true; }

let audioCtx;
function beep(n = 1, freq = 880) {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < n; i++) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = freq; o.connect(g); g.connect(audioCtx.destination);
      const t = audioCtx.currentTime + i * 0.3;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.start(t); o.stop(t + 0.25);
    }
  } catch { /* ignore */ }
}

/* =========================================================
   Route planner / measure
   ========================================================= */
function startPlan(mode) {
  closeSheet(); unfollow();
  state.plan = { mode, points: [] };
  $('planBar').hidden = false;
  renderPlanBar(); refreshPlan();
  toast(mode === 'measure' ? 'Tap the map to measure' : 'Tap the map to add route points');
}
function refreshPlan() {
  const p = state.plan;
  src('plan')?.setData(fc(p ? [...(p.points.length > 1 ? [line(p.points)] : []), ...p.points.map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }))] : []));
}
function renderPlanBar() {
  const p = state.plan; if (!p) return;
  const total = pathLength(p.points);
  const lastLeg = p.points.length > 1 ? `${fmtDist(distance(p.points.at(-2), p.points.at(-1)), S.units)} @ ${Math.round(bearing(p.points.at(-2), p.points.at(-1)))}°` : '—';
  $('planInfo').innerHTML = `<b>${p.mode === 'measure' ? 'Measure' : 'Plan route'}</b> · ${p.points.length} pts · total <b>${fmtDist(total, S.units)}</b> · last leg ${lastLeg}`;
  $('planSave').hidden = p.mode === 'measure';
  $('planGo').hidden = p.points.length < 2;
}
function stopPlan() { state.plan = null; $('planBar').hidden = true; refreshPlan(); }
async function savePlan() {
  const p = state.plan; if (!p || p.points.length < 2) return toast('Add at least two points');
  const name = await prompt('Save route', 'Route name', `Route ${state.tracks.filter((t) => t.kind === 'route').length + 1}`);
  if (name === null) return;
  const t = { id: store.uid(), kind: 'route', name: name || 'Route', created: Date.now(), coords: p.points.map((c) => [c[0], c[1], null, null]), stats: { dist: pathLength(p.points) }, color: '#00e5ff', visible: true };
  await store.put('tracks', t); state.tracks.push(t); stopPlan(); refreshOverlays();
  toast(`Route “${t.name}” saved — find it in Trips → Routes`);
}

/* =========================================================
   Waypoints
   ========================================================= */
async function addWaypoint(lon, lat, ele, defaultName) {
  const name = await prompt('New waypoint', 'Name', defaultName || `WP ${state.waypoints.length + 1}`);
  if (name === null) return null;
  const w = { id: store.uid(), name: name || 'Waypoint', lon, lat, ele: ele ?? null, created: Date.now(), color: '#e8a33d', alertRadius: 0 };
  await store.put('waypoints', w); state.waypoints.push(w); refreshOverlays();
  toast(`Waypoint “${w.name}” saved`);
  return w;
}
function markHere() {
  const f = state.fix;
  if (!f) { const c = map.getCenter(); return addWaypoint(c.lng, c.lat, null, 'Map point'); }
  addWaypoint(f.lon, f.lat, f.alt ?? state.ground);
}

let popup;
async function showPointPopup(lngLat, title, wp) {
  popup?.remove();
  const div = document.createElement('div');
  div.className = 'pop';
  const p = [lngLat.lng, lngLat.lat];
  const me = state.fix ? [state.fix.lon, state.fix.lat] : null;
  const dist = me ? `${fmtDist(distance(me, p), S.units)} · ${Math.round(bearing(me, p))}° from you` : '';
  div.innerHTML = `<div class="title"></div><div class="sub">${fmtCoord(p[0], p[1], S.coordFormat)}<br>${dist}<br><span class="ele">elevation …</span></div>
    <div class="btns"><button class="primary" data-a="go">➤ Go here</button>${wp ? '<button class="btn" data-a="edit">Edit</button>' : '<button class="btn" data-a="save">⚑ Save</button>'}</div>`;
  div.querySelector('.title').textContent = title;
  div.querySelector('[data-a=go]').onclick = () => { popup.remove(); startGoto(p, wp ? wp.name : 'Map point'); };
  const s = div.querySelector('[data-a=save]'); if (s) s.onclick = async () => { popup.remove(); await addWaypoint(p[0], p[1], await tiles.elevationAt(p[0], p[1]).catch(() => null)); };
  const e = div.querySelector('[data-a=edit]'); if (e) e.onclick = () => { popup.remove(); editWaypoint(wp); };
  popup = new maplibregl.Popup({ closeOnClick: true, maxWidth: '330px' }).setLngLat(lngLat).setDOMContent(div).addTo(map);
  const ele = await tiles.elevationAt(p[0], p[1]).catch(() => null);
  div.querySelector('.ele').textContent = ele != null ? `elevation ${fmtAlt(ele, S.units)}` : '';
}

function editWaypoint(w) {
  openSheet('Edit waypoint', `
    <div class="field"><label>Name</label><input type="text" id="wName"></div>
    <div class="field"><label>Notes</label><textarea id="wNotes"></textarea></div>
    <div class="field"><label>Colour</label><div class="seg" id="wColor">${['#e8a33d', '#e5484d', '#2f9bff', '#46a758', '#c04cff', '#ffffff'].map((c) => `<button data-c="${c}" style="color:${c}">●</button>`).join('')}</div></div>
    <div class="field"><label>Proximity alert (hazard, soft sand, camp…)</label><div class="seg" id="wAlert">${[[0, 'Off'], [100, '100 m'], [250, '250 m'], [500, '500 m'], [1000, '1 km']].map(([v, l]) => `<button data-v="${v}">${l}</button>`).join('')}</div></div>
    <p class="note">${fmtCoord(w.lon, w.lat, S.coordFormat)}${w.ele != null ? ' · ' + fmtAlt(w.ele, S.units) : ''}</p>
    <div class="btns"><button class="primary" data-a="save">Save</button><button class="btn" data-a="go">➤ Go To</button><button class="btn danger" data-a="del">Delete</button></div>`, {
    save: async () => { w.name = $('wName').value || w.name; w.notes = $('wNotes').value; await store.put('waypoints', w); refreshOverlays(); closeSheet(); },
    go: () => { closeSheet(); startGoto([w.lon, w.lat], w.name); },
    del: async () => {
      if (!(await confirmBox(`Delete waypoint “${esc(w.name)}”?`))) return;
      await store.del('waypoints', w.id); state.waypoints = state.waypoints.filter((x) => x !== w); refreshOverlays(); closeSheet();
    },
  });
  $('wName').value = w.name; $('wNotes').value = w.notes || '';
  const seg = $('wColor'), al = $('wAlert');
  const mark = () => { seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.c === (w.color || '#e8a33d'))); al.querySelectorAll('button').forEach((b) => b.classList.toggle('on', +b.dataset.v === (w.alertRadius || 0))); };
  seg.onclick = (e) => { const c = e.target.closest('button')?.dataset.c; if (c) { w.color = c; mark(); } };
  al.onclick = (e) => { const v = e.target.closest('button')?.dataset.v; if (v != null) { w.alertRadius = +v; if (+v && w.color === '#e8a33d') w.color = '#e5484d'; mark(); } };
  mark();
}

/* =========================================================
   Sheets
   ========================================================= */
let sheetHandlers = {};
function openSheet(title, html, handlers = {}) {
  $('sheetTitle').textContent = title; $('sheetBody').innerHTML = html; sheetHandlers = handlers; $('sheet').hidden = false;
}
function closeSheet() { $('sheet').hidden = true; $('sheetBody').innerHTML = ''; sheetHandlers = {}; resolveDialog?.(null); }
$('sheetClose').onclick = closeSheet;
$('sheet').addEventListener('click', (e) => {
  if (e.target === $('sheet')) return closeSheet();
  const b = e.target.closest('[data-a]');
  if (b && sheetHandlers[b.dataset.a]) sheetHandlers[b.dataset.a](b.dataset.id, b);
});
let resolveDialog;
function prompt(title, label, value = '') {
  return new Promise((resolve) => {
    openSheet(title, `<div class="field"><label>${label}</label><input type="text" id="pIn"></div><div class="btns"><button class="primary" data-a="ok">Save</button><button class="btn" data-a="cancel">Cancel</button></div>`, {
      ok: () => { const v = $('pIn').value.trim(); resolveDialog = null; closeSheet(); resolve(v); },
      cancel: () => closeSheet(),
    });
    resolveDialog = (v) => { resolveDialog = null; resolve(v); };
    const i = $('pIn'); i.value = value; i.focus(); i.select();
    i.onkeydown = (e) => { if (e.key === 'Enter') sheetHandlers.ok(); };
  });
}
function confirmBox(text) {
  return new Promise((resolve) => {
    const prev = { title: $('sheetTitle').textContent, html: $('sheetBody').innerHTML, h: sheetHandlers, open: !$('sheet').hidden };
    openSheet('Confirm', `<p>${text}</p><div class="btns"><button class="primary" data-a="yes">Yes</button><button class="btn" data-a="no">No</button></div>`, {
      yes: () => { prev.open ? openSheet(prev.title, prev.html, prev.h) : closeSheet(); resolve(true); },
      no: () => { prev.open ? openSheet(prev.title, prev.html, prev.h) : closeSheet(); resolve(false); },
    });
  });
}
let toastT;
function toast(msg, ms = 3000) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }
const segHtml = (key, opts) => `<div class="seg">${opts.map(([v, l]) => `<button data-a="set" data-id="${key}:${v}" class="${String(S[key]) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;

/* ---------- Go To ---------- */
function gotoSheet() {
  const me = state.fix ? [state.fix.lon, state.fix.lat] : null;
  const wps = [...state.waypoints].sort((a, b) => (me ? distance(me, [a.lon, a.lat]) - distance(me, [b.lon, b.lat]) : b.created - a.created));
  openSheet('Go To', `
    <div class="field"><label>Coordinates</label><input type="text" id="gCoord" placeholder="24.7136, 46.6753 · N24 42.816 E46 40.518 · Google Maps link"></div>
    <div class="btns" style="margin-bottom:16px"><button class="primary" data-a="go">➤ Navigate</button><button class="btn" data-a="save">⚑ Save as waypoint</button><button class="btn" data-a="show">Show on map</button></div>
    <div class="field"><label>Project a point — bearing and distance from ${me ? 'your position' : 'the map centre'}</label>
      <div class="btns"><input type="number" id="pBrg" placeholder="Bearing °" style="flex:1"><input type="number" id="pDist" placeholder="Distance ${S.units === 'imperial' ? 'mi' : 'km'}" style="flex:1"><button class="btn" data-a="proj">➤ Go</button></div></div>
    <div class="field"><label>Or pick a waypoint</label></div>
    ${wps.length ? wps.map((w) => `<div class="row"><div class="swatch" style="background:${w.color || '#e8a33d'}"></div><div class="grow"><div class="title">${esc(w.name)}</div><div class="sub">${me ? fmtDist(distance(me, [w.lon, w.lat]), S.units) + ' · ' + Math.round(bearing(me, [w.lon, w.lat])) + '° · ' : ''}${fmtCoord(w.lon, w.lat, S.coordFormat)}</div></div><button class="primary" data-a="wp" data-id="${w.id}">➤</button></div>`).join('') : '<div class="empty">No waypoints yet — tap Mark while driving or long-press the map.</div>'}`, {
    go: () => { const c = parseCoord($('gCoord').value); if (!c) return toast('Could not read those coordinates'); closeSheet(); startGoto(c, fmtCoord(c[0], c[1], S.coordFormat)); },
    save: async () => { const c = parseCoord($('gCoord').value); if (!c) return toast('Could not read those coordinates'); closeSheet(); await addWaypoint(c[0], c[1], null); },
    show: () => { const c = parseCoord($('gCoord').value); if (!c) return toast('Could not read those coordinates'); closeSheet(); unfollow(); map.flyTo({ center: c, zoom: Math.max(map.getZoom(), 13) }); showPointPopup({ lng: c[0], lat: c[1] }, 'Entered point'); },
    proj: () => {
      const b = +$('pBrg').value, dk = +$('pDist').value;
      if (!isFinite(b) || !(dk > 0)) return toast('Enter a bearing and a distance');
      const from = me || [map.getCenter().lng, map.getCenter().lat];
      const c = destination(from, b, dk * (S.units === 'imperial' ? 1609.344 : 1000));
      closeSheet(); startGoto(c, `${Math.round(b)}° / ${dk} ${S.units === 'imperial' ? 'mi' : 'km'}`);
    },
    wp: (id) => { const w = state.waypoints.find((x) => x.id === id); closeSheet(); startGoto([w.lon, w.lat], w.name); },
  });
}

/* ---------- Search & POIs ---------- */
function searchSheet(q = '') {
  const me = state.fix ? [state.fix.lon, state.fix.lat] : [map.getCenter().lng, map.getCenter().lat];
  let results = [];
  const coord = parseCoord(q);
  if (q) {
    results = poiSearch(q, me);
    // Also search what the offline street map has loaded around the view.
    if (src('protomaps')) {
      const seen = new Set(results.map((r) => r[1][3]));
      for (const sl of ['places', 'pois']) {
        for (const f of map.querySourceFeatures('protomaps', { sourceLayer: sl })) {
          const n = f.properties['name:en'] || f.properties.name, na = f.properties['name:ar'] || f.properties.name;
          if (!n || seen.has(n) || !(`${n} ${na}`.toLowerCase().includes(q.toLowerCase()))) continue;
          seen.add(n);
          const c = f.geometry.type === 'Point' ? f.geometry.coordinates : null; if (!c) continue;
          results.push([distance(me, c), [c[0], c[1], sl === 'places' ? 'place' : 'sight', n, na]]);
        }
      }
      results.sort((a, b) => a[0] - b[0]);
    }
  }
  const row = (d, p, i) => `<div class="row"><div class="grow"><div class="title">${POI_CATS[p[2]]?.icon || '•'} ${esc(p[3] || p[4] || POI_CATS[p[2]]?.label)}</div><div class="sub">${POI_CATS[p[2]]?.label || ''} · ${fmtDist(d, S.units)} · ${Math.round(bearing(me, p))}° ${p[4] && p[3] && p[4] !== p[3] ? '· ' + esc(p[4]) : ''}</div></div><button class="btn sm" data-a="show" data-id="${i}">Show</button><button class="primary" data-a="go" data-id="${i}">➤</button></div>`;
  openSheet('Search', `
    <div class="btns" style="margin-bottom:10px"><input type="text" id="sQ" placeholder="Town, place, fuel station… or coordinates" style="flex:1"><button class="primary" data-a="find">Search</button></div>
    ${coord ? `<div class="row"><div class="grow"><div class="title">📍 ${fmtCoord(coord[0], coord[1], S.coordFormat)}</div></div><button class="primary" data-a="gocoord">➤ Go</button></div>` : ''}
    ${q ? (results.length ? results.map(([d, p], i) => row(d, p, i)).join('') : '<div class="empty">Nothing found offline.</div>') : `
      <div class="field"><label>Nearest ${state.fix ? 'to you' : 'to map centre'}</label></div>
      <div class="chips">${Object.entries(POI_CATS).map(([k, c]) => `<button class="btn" data-a="cat" data-id="${k}">${c.icon} ${c.label}</button>`).join('')}</div>
      <p class="note">${poiCount() ? `${poiCount().toLocaleString()} places & POIs available offline${state.poiVersion ? ' (pack ' + fmtVer(state.poiVersion) + ')' : ''}.` : 'Install the <b>Places & POIs</b> pack from Maps → Updates for full offline search. Until then, search covers names visible on the loaded map.'}</p>
      <label class="toggle"><span>Show POIs on the map</span><input type="checkbox" id="sPois" ${S.showPois ? 'checked' : ''}></label>`}`, {
    find: () => searchSheet($('sQ').value),
    gocoord: () => { closeSheet(); startGoto(coord, fmtCoord(coord[0], coord[1], S.coordFormat)); },
    cat: (k) => {
      const list = nearest(me, k, 30);
      openSheet(`Nearest: ${POI_CATS[k].label}`, list.length ? list.map(([d, p], i) => row(d, p, i)).join('') : '<div class="empty">None in the offline POI pack.</div>', {
        go: (i) => { const p = list[+i][1]; closeSheet(); startGoto([p[0], p[1]], p[3] || POI_CATS[k].label); },
        show: (i) => { const p = list[+i][1]; closeSheet(); unfollow(); map.flyTo({ center: [p[0], p[1]], zoom: 15 }); showPointPopup({ lng: p[0], lat: p[1] }, p[3] || POI_CATS[k].label); },
      });
    },
    go: (i) => { const p = results[+i][1]; closeSheet(); startGoto([p[0], p[1]], p[3] || p[4]); },
    show: (i) => { const p = results[+i][1]; closeSheet(); unfollow(); map.flyTo({ center: [p[0], p[1]], zoom: 14 }); showPointPopup({ lng: p[0], lat: p[1] }, p[3] || p[4] || ''); },
  });
  const i = $('sQ'); i.value = q; i.onkeydown = (e) => { if (e.key === 'Enter') searchSheet(i.value); };
  const t = $('sPois'); if (t) t.onchange = (e) => { setS('showPois', e.target.checked); refreshOverlays(); };
}

/* ---------- TrackBack ---------- */
function trackBackSheet() {
  const me = state.fix ? [state.fix.lon, state.fix.lat] : null;
  const list = [...state.tracks].sort((a, b) => b.created - a.created);
  const cur = state.rec.points.length > 5;
  openSheet('TrackBack & follow', `
    <p class="note">Retrace a trip back to where it started, or follow a trip / planned route forwards.</p>
    ${cur ? `<div class="row"><div class="swatch" style="background:#e5000b"></div><div class="grow"><div class="title">Current recording</div><div class="sub">${fmtDist(state.rec.dist, S.units)} · back to start point</div></div><button class="primary" data-a="cur">↶ Back to start</button></div>` : ''}
    ${list.map((t) => `<div class="row"><div class="swatch" style="background:${t.color}"></div><div class="grow"><div class="title">${t.kind === 'route' ? '⇢ ' : ''}${esc(t.name)}</div><div class="sub">${new Date(t.created).toLocaleDateString()} · ${fmtDist(t.stats?.dist ?? pathLength(t.coords), S.units)}${me ? ' · start ' + fmtDist(distance(me, t.coords[0]), S.units) + ' away' : ''}</div></div><button class="primary" data-a="back" data-id="${t.id}">↶ Back</button><button class="btn" data-a="fwd" data-id="${t.id}">Follow</button></div>`).join('')}
    ${!cur && !list.length ? '<div class="empty">No trips yet. Recording starts automatically once you move.</div>' : ''}`, {
    cur: () => { closeSheet(); startRoute(state.rec.points, 'current trip', true); },
    back: (id) => { const t = state.tracks.find((x) => x.id === id); closeSheet(); startRoute(t.coords, t.name, true); },
    fwd: (id) => { const t = state.tracks.find((x) => x.id === id); closeSheet(); startRoute(t.coords, t.name, false); },
  });
}

/* ---------- Trips library ---------- */
let libTab = 'trips';
function tripsSheet() {
  const me = state.fix ? [state.fix.lon, state.fix.lat] : null;
  const byKind = (k) => [...state.tracks].filter((t) => (k === 'trips' ? !t.kind || t.kind === 'trip' : k === 'routes' ? t.kind === 'route' : t.kind === 'import')).sort((a, b) => b.created - a.created);
  const wps = [...state.waypoints].sort((a, b) => b.created - a.created);
  const trackRow = (t) => `<div class="row"><div class="swatch" style="background:${t.color};opacity:${t.visible === false ? 0.25 : 1}"></div><div class="grow"><div class="title">${esc(t.name)}</div><div class="sub">${new Date(t.created).toLocaleDateString()} · ${fmtDist(t.stats?.dist ?? pathLength(t.coords), S.units)}${t.stats?.moving ? ' · ' + fmtDuration(t.stats.moving) : ''}${t.segStarts?.length > 1 ? ' · ' + t.segStarts.length + ' days/legs' : ''}</div></div><button class="primary sm" data-a="open" data-id="${t.id}">Open</button></div>`;
  const counts = { trips: byKind('trips').length, routes: byKind('routes').length, imports: byKind('imports').length, wpts: wps.length };
  const body = libTab === 'wpts'
    ? (wps.length ? wps.map((w) => `<div class="row"><div class="swatch" style="background:${w.color || '#e8a33d'}"></div><div class="grow"><div class="title">${esc(w.name)}${w.alertRadius ? ' ⚠' : ''}</div><div class="sub">${me ? fmtDist(distance(me, [w.lon, w.lat]), S.units) + ' · ' : ''}${fmtCoord(w.lon, w.lat, S.coordFormat)}</div></div><button class="btn sm" data-a="wshow" data-id="${w.id}">Show</button><button class="btn sm" data-a="wgo" data-id="${w.id}">➤</button><button class="btn sm" data-a="wedit" data-id="${w.id}">Edit</button></div>`).join('') : '<div class="empty">No waypoints</div>')
    : (byKind(libTab).map(trackRow).join('') || `<div class="empty">${libTab === 'trips' ? 'No trips yet — they are recorded automatically while you drive.' : libTab === 'routes' ? 'No routes — use Tools → Route planner.' : 'No imported tracks — import GPX/KML below.'}</div>`);
  openSheet('Trips', `
    <div class="tabs">${[['trips', 'Trips'], ['routes', 'Routes'], ['imports', 'Imported'], ['wpts', 'Waypoints']].map(([k, l]) => `<button data-a="tab" data-id="${k}" class="${libTab === k ? 'on' : ''}">${l} (${counts[k]})</button>`).join('')}</div>
    <div class="btns" style="margin-bottom:8px"><button class="primary" data-a="import">Import GPX / KML / GeoJSON</button><button class="btn" data-a="expall">Export all (GPX)</button></div>
    ${body}`, {
    tab: (id) => { libTab = id; tripsSheet(); },
    import: () => pickFile('.gpx,.kml,.geojson,.json,application/gpx+xml,application/xml,text/xml', importFiles, true),
    expall: () => exportGPX({ tracks: state.tracks, waypoints: state.waypoints }, `rimal-all-${dateStamp()}.gpx`),
    open: (id) => tripDetail(state.tracks.find((x) => x.id === id)),
    wshow: (id) => { const w = state.waypoints.find((x) => x.id === id); closeSheet(); unfollow(); map.flyTo({ center: [w.lon, w.lat], zoom: Math.max(14, map.getZoom()) }); showPointPopup({ lng: w.lon, lat: w.lat }, w.name, w); },
    wgo: (id) => { const w = state.waypoints.find((x) => x.id === id); closeSheet(); startGoto([w.lon, w.lat], w.name); },
    wedit: (id) => editWaypoint(state.waypoints.find((x) => x.id === id)),
  });
}

function tripWaypoints(t) {
  const end = t.end || (t.coords.at(-1)?.[3]) || t.created;
  return state.waypoints.filter((w) => w.created >= t.created - 600000 && w.created <= end + 600000);
}
function tripDetail(t) {
  const s = t.stats || {};
  const wps = tripWaypoints(t);
  const avg = s.moving ? s.dist / s.moving : null;
  openSheet(t.kind === 'route' ? 'Route' : 'Trip', `
    <div class="field"><label>Name</label><input type="text" id="tName"></div>
    <div class="grid stats">
      <div class="cell"><label>Distance</label><b>${fmtDist(s.dist ?? pathLength(t.coords), S.units)}</b></div>
      <div class="cell"><label>Moving time</label><b>${fmtDuration(s.moving)}</b></div>
      <div class="cell"><label>Total time</label><b>${fmtDuration(s.duration)}</b></div>
      <div class="cell"><label>Avg moving</label><b>${fmtSpeed(avg, S.units)} ${speedUnit(S.units)}</b></div>
      <div class="cell"><label>Max speed</label><b>${fmtSpeed(s.max, S.units)} ${speedUnit(S.units)}</b></div>
      <div class="cell"><label>Climb</label><b>${fmtAlt(s.ascent, S.units)}</b></div>
    </div>
    <p class="note">${new Date(t.created).toLocaleString()}${t.end ? ' → ' + new Date(t.end).toLocaleString() : ''}${t.segStarts?.length > 1 ? ` · ${t.segStarts.length} legs` : ''}</p>
    ${t.kind === 'route' ? '' : profileSVG(t.coords, S.units)}
    <div class="field"><label>Notes</label><textarea id="tNotes" placeholder="Who came, conditions, fuel used, where you camped…"></textarea></div>
    ${wps.length ? `<div class="field"><label>Waypoints on this trip</label></div>${wps.map((w) => `<div class="row"><div class="swatch" style="background:${w.color || '#e8a33d'}"></div><div class="grow"><div class="title">${esc(w.name)}</div><div class="sub">${new Date(w.created).toLocaleTimeString()}</div></div></div>`).join('')}` : ''}
    <div class="btns" style="margin-top:12px">
      <button class="primary" data-a="save">Save</button>
      <button class="btn" data-a="show">Show on map</button>
      <button class="btn" data-a="back">↶ TrackBack</button>
      <button class="btn" data-a="fwd">Follow</button>
      ${t.kind === 'route' ? '' : '<button class="btn" data-a="cont">Continue this trip next time</button>'}
      <button class="btn" data-a="vis">${t.visible === false ? 'Show' : 'Hide'} on map</button>
      <button class="btn" data-a="exp">Export GPX</button>
      <button class="btn danger" data-a="del">Delete</button>
    </div>`, {
    save: async () => { t.name = $('tName').value || t.name; t.notes = $('tNotes').value; await store.put('tracks', t); toast('Saved'); tripsSheet(); },
    show: () => { closeSheet(); unfollow(); map.fitBounds(bbox(t.coords), { padding: 60 }); },
    back: () => { closeSheet(); startRoute(t.coords, t.name, true); },
    fwd: () => { closeSheet(); startRoute(t.coords, t.name, false); },
    cont: () => { setS('continueTripId', t.id); toast(`Your next drive will be added to “${t.name}”`); },
    vis: async () => { t.visible = t.visible === false; await store.put('tracks', t); refreshOverlays(); tripDetail(t); },
    exp: () => exportGPX({ tracks: [t], waypoints: tripWaypoints(t) }, `${t.name.replace(/[^\w\- ]+/g, '_')}.gpx`),
    del: async () => {
      if (!(await confirmBox(`Delete “${esc(t.name)}”? This cannot be undone.`))) return;
      await store.del('tracks', t.id); state.tracks = state.tracks.filter((x) => x.id !== t.id);
      if (S.continueTripId === t.id) setS('continueTripId', null);
      refreshOverlays(); tripsSheet();
    },
  });
  $('tName').value = t.name; $('tNotes').value = t.notes || '';
}

/* ---------- import / export ---------- */
function parseKML(text, fileName) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const coords = (s) => s.trim().split(/\s+/).map((c) => c.split(',').map(Number)).filter((c) => c.length >= 2 && isFinite(c[0])).map((c) => [c[0], c[1], c[2] ?? null, null]);
  const tracks = [], waypoints = [];
  for (const pm of doc.getElementsByTagName('Placemark')) {
    const name = pm.getElementsByTagName('name')[0]?.textContent?.trim() || fileName;
    for (const ls of pm.getElementsByTagName('LineString')) { const c = coords(ls.getElementsByTagName('coordinates')[0]?.textContent || ''); if (c.length > 1) tracks.push({ name, coords: c }); }
    for (const pt of pm.getElementsByTagName('Point')) { const c = coords(pt.getElementsByTagName('coordinates')[0]?.textContent || '')[0]; if (c) waypoints.push({ name, lon: c[0], lat: c[1], ele: c[2] }); }
    for (const gx of pm.getElementsByTagNameNS('*', 'Track')) { const c = [...gx.getElementsByTagNameNS('*', 'coord')].map((e) => e.textContent.trim().split(/\s+/).map(Number)).map((c) => [c[0], c[1], c[2] ?? null, null]); if (c.length > 1) tracks.push({ name, coords: c }); }
  }
  return { tracks, waypoints };
}
function parseGeoJSON(text, fileName) {
  const g = JSON.parse(text); const tracks = [], waypoints = [];
  const feats = g.type === 'FeatureCollection' ? g.features : g.type === 'Feature' ? [g] : [{ geometry: g, properties: {} }];
  for (const f of feats) {
    const name = f.properties?.name || fileName, geom = f.geometry; if (!geom) continue;
    const c3 = (c) => [c[0], c[1], c[2] ?? null, null];
    if (geom.type === 'Point') waypoints.push({ name, lon: geom.coordinates[0], lat: geom.coordinates[1], ele: geom.coordinates[2] ?? null });
    if (geom.type === 'LineString') tracks.push({ name, coords: geom.coordinates.map(c3) });
    if (geom.type === 'MultiLineString') geom.coordinates.forEach((l, i) => tracks.push({ name: `${name} ${i + 1}`, coords: l.map(c3) }));
  }
  return { tracks, waypoints };
}
async function importFiles(files) {
  let nt = 0, nw = 0;
  for (const file of files) {
    try {
      const text = await file.text(), base = file.name.replace(/\.\w+$/, '');
      if (/\.json$/i.test(file.name) && text.includes('"rimalBackup"')) { await restoreBackup(JSON.parse(text)); continue; }
      const { tracks, waypoints } = /\.kml$/i.test(file.name) ? parseKML(text, base) : /\.(geo)?json$/i.test(file.name) ? parseGeoJSON(text, base) : parseGPX(text, base);
      for (const t of tracks) {
        const rec = { id: store.uid(), kind: 'import', name: t.name, created: t.coords[0][3] || Date.now(), coords: t.coords, stats: { dist: pathLength(t.coords) }, color: TRACK_COLORS[(state.tracks.length + 2) % TRACK_COLORS.length], visible: true };
        await store.put('tracks', rec); state.tracks.push(rec); nt++;
      }
      for (const w of waypoints) { const rec = { id: store.uid(), icon: 'pin', ...w, created: Date.now(), color: '#2f9bff', alertRadius: 0 }; await store.put('waypoints', rec); state.waypoints.push(rec); nw++; }
    } catch (e) { toast(`${file.name}: ${e.message}`); }
  }
  refreshOverlays();
  if (nt || nw) { toast(`Imported ${nt} track(s), ${nw} waypoint(s)`); libTab = nt ? 'imports' : 'wpts'; }
  tripsSheet();
}
async function exportGPX(data, filename) {
  const where = await native.saveText(filename, toGPX(data, filename.replace(/\.gpx$/, '')));
  toast(where ? `Saved to ${where}` : `Exported ${filename}`, 5000);
}
const dateStamp = () => new Date().toISOString().slice(0, 10);

async function backup() {
  const settings = { ...S }; delete settings.updateToken;
  const data = { rimalBackup: 2, at: new Date().toISOString(), tracks: state.tracks, waypoints: state.waypoints, areas: state.areas, settings };
  const where = await native.saveText(`rimal-backup-${dateStamp()}.json`, JSON.stringify(data));
  toast(where ? `Backup saved to ${where}` : 'Backup downloaded', 5000);
}
async function restoreBackup(b) {
  if (!(await confirmBox(`Restore backup from ${new Date(b.at).toLocaleString()}? Trips and waypoints are merged with what is on this device.`))) return;
  for (const t of b.tracks || []) { await store.put('tracks', t); if (!state.tracks.some((x) => x.id === t.id)) state.tracks.push(t); }
  for (const w of b.waypoints || []) { await store.put('waypoints', w); if (!state.waypoints.some((x) => x.id === w.id)) state.waypoints.push(w); }
  for (const k of ['units', 'coordFormat', 'fields', 'fuelRange', 'pitchWarn', 'rollWarn', 'updateRepo', 'satSource', 'mapMode', 'lang']) if (b.settings?.[k] != null) setS(k, b.settings[k]);
  refreshOverlays(); renderFields(); updateDash();
  toast(`Restored ${b.tracks?.length || 0} trips/routes and ${b.waypoints?.length || 0} waypoints`);
}

/* ---------- Maps, imagery, downloads, updates ---------- */
const gb = (b) => (b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(0) + ' MB' : Math.max(0, Math.round((b || 0) / 1e3)) + ' KB');
let mapsTab = 'view';
async function mapsSheet() {
  const inst = installedVersions();
  const files = Object.values(state.maps).sort((a, b) => a.kind.localeCompare(b.kind) || b.version.localeCompare(a.version));
  const ss = tiles.SAT_SOURCES;
  const tab = {
    view: `
      <div class="field"><label>Map view</label>${segHtml('mapMode', [['hybrid', '🛰 Satellite + roads'], ['satellite', '🛰 Satellite only'], ['topo', '🗺 Topo map']])}</div>
      <label class="toggle"><span>3D terrain</span><input type="checkbox" id="m3d" ${S.terrain3d ? 'checked' : ''}></label>
      <label class="toggle"><span>Terrain shading (hillshade)</span><input type="checkbox" id="mHill" ${S.hillshade ? 'checked' : ''}></label>
      <label class="toggle"><span>Contour lines</span><input type="checkbox" id="mCont" ${S.contours ? 'checked' : ''}></label>
      <div class="field" style="margin-top:10px"><label>Imagery brightness / opacity</label><input type="range" id="mSatOp" min="0.3" max="1" step="0.05" value="${S.satOpacity}"></div>
      <div class="field"><label>Colours</label>${segHtml('night', [['false', '☀ Day'], ['true', '☾ Night']])}</div>
      <div class="field"><label>Map labels</label>${segHtml('lang', [['en', 'English'], ['ar', 'العربية']])}</div>
      <label class="toggle"><span>Show saved trips</span><input type="checkbox" id="mTracks" ${S.showSavedTracks ? 'checked' : ''}></label>
      <label class="toggle"><span>Show waypoints</span><input type="checkbox" id="mWpts" ${S.showWaypoints ? 'checked' : ''}></label>`,
    imagery: `
      <div class="field"><label>Satellite imagery source</label>${Object.entries(ss).map(([k, s]) => `<label class="radio"><input type="radio" name="satsrc" value="${k}" ${S.satSource === k ? 'checked' : ''}><span><b>${s.name}</b><br><small>${s.licence}</small></span></label>`).join('')}</div>
      <div class="field" ${S.satSource === 'custom' ? '' : 'hidden'} id="customWrap"><label>Custom URL ({z} {x} {y})</label><input type="text" id="mCustom" value="${esc(S.customSatUrl)}" placeholder="https://example.com/tiles/{z}/{x}/{y}.jpg"></div>
      <label class="toggle"><span>Keep every tile I view online, for offline use</span><input type="checkbox" id="mCache" ${S.cacheWhileBrowsing ? 'checked' : ''}></label>
      <div class="btns" style="margin:14px 0"><button class="primary" data-a="area">⬇ Download this area for offline</button></div>
      <p class="note" id="cacheCount">Counting stored tiles…</p>
      <h3>Downloaded areas</h3>
      ${state.areas.length ? state.areas.map((a) => `<div class="row"><div class="grow"><div class="title">${esc(a.name)}</div><div class="sub">${a.layers.map((l) => (l === 'sat' ? 'imagery z' + a.maxZoom : 'terrain')).join(' + ')} · ${a.tiles.toLocaleString()} tiles · ${gb(a.bytes)} · ${new Date(a.updated || a.created).toLocaleDateString()}${a.failed ? ` · ${a.failed} missing` : ''}</div></div><button class="btn sm" data-a="aview" data-id="${a.id}">View</button><button class="btn sm" data-a="arefresh" data-id="${a.id}">Update</button><button class="btn sm danger" data-a="adel" data-id="${a.id}">✕</button></div>`).join('') : '<div class="empty">No areas downloaded yet. Pan to where you will drive, then tap Download.</div>'}`,
    updates: `
      <p class="note">New map versions are built every month in the cloud. When this unit is online, Rimal checks for them and installs them in the background. <b>The previous version is always kept</b>, so you still have full detail offline if a download fails or is incomplete.</p>
      <div class="field"><label>Update source (GitHub repository “owner/name”)</label><input type="text" id="uRepo" value="${esc(S.updateRepo)}" placeholder="yourname/rimal"></div>
      <div class="field"><label>Access token (only for a private repository)</label><input type="text" id="uTok" value="${S.updateToken ? '••••••••' : ''}" placeholder="optional"></div>
      <div class="field"><label>Automatic updates</label>${segHtml('autoUpdate', [['wifi', 'On Wi-Fi'], ['any', 'Any connection'], ['off', 'Off']])}</div>
      <div class="btns" style="margin-bottom:12px"><button class="primary" data-a="check">⟳ Check for updates now</button><button class="btn" data-a="import">Import map file from USB</button></div>
      <p class="note">${state.update.msg || (S.lastUpdateCheck ? 'Last checked ' + new Date(S.lastUpdateCheck).toLocaleString() : 'Not checked yet')}</p>
      ${Object.entries(packs.KINDS).map(([k, label]) => {
        const v = inst[k] || []; const r = state.remote?.[k];
        return `<div class="row"><div class="grow"><div class="title">${label}</div><div class="sub">${v.length ? 'In use: ' + fmtVer(v[0]) + (v[1] ? ' · backup: ' + fmtVer(v[1]) : '') : 'Not installed'}${r ? ` · latest online: ${fmtVer(r.version)} (${gb(r.size)})` : ''}</div></div></div>`;
      }).join('')}
      <h3>Files on this unit</h3>
      ${files.length ? files.map((m) => `<div class="row"><div class="grow"><div class="title">${esc(m.name)}</div><div class="sub">${m.kind} · zoom ${m.minZoom}–${m.maxZoom} · ${gb(m.size)}${S.baseMap === m.name ? ' · <b>ACTIVE</b>' : ''}</div></div>${m.kind === 'vector' && S.baseMap !== m.name ? `<button class="btn sm" data-a="usebase" data-id="${m.name}">Use</button>` : ''}<button class="btn sm danger" data-a="mdel" data-id="${m.name}">✕</button></div>`).join('') : '<div class="empty">No offline map files yet</div>'}
      <p class="note" id="mStore"></p>`,
  };
  openSheet('Maps & layers', `
    <div class="tabs">${[['view', 'View'], ['imagery', 'Satellite & areas'], ['updates', 'Updates & files']].map(([k, l]) => `<button data-a="mtab" data-id="${k}" class="${mapsTab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${tab[mapsTab]}
    <div class="progress" id="mProg" hidden><div></div></div>`, {
    mtab: (id) => { mapsTab = id; mapsSheet(); },
    set: (id) => { const [k, v] = id.split(':'); setS(k, v === 'true' ? true : v === 'false' ? false : v, ['mapMode', 'night', 'lang'].includes(k)); mapsSheet(); },
    area: () => areaSheet(),
    aview: (id) => { const a = state.areas.find((x) => x.id === id); closeSheet(); unfollow(); map.fitBounds([[a.bbox[0], a.bbox[1]], [a.bbox[2], a.bbox[3]]]); },
    arefresh: (id) => runAreaDownload(state.areas.find((x) => x.id === id), true),
    adel: async (id) => {
      const a = state.areas.find((x) => x.id === id);
      if (!(await confirmBox(`Delete the offline area “${esc(a.name)}”?`))) return;
      const others = state.areas.filter((x) => x.id !== id);
      await tiles.deleteAreaTiles(a, others);
      await store.del('areas', id); state.areas = others; mapsSheet();
    },
    check: () => { saveUpdateFields(); checkUpdates(true); mapsSheet(); },
    import: () => pickFile('.pmtiles,application/octet-stream,*/*', importMapFile, false),
    usebase: (id) => { S.autoBase = false; store.saveSetting('autoBase', false); setS('baseMap', id, true); mapsSheet(); },
    mdel: async (id) => {
      if (!(await confirmBox(`Delete map file “${esc(id)}” from this unit?`))) return;
      await store.deleteMapFile(id); await loadMaps(); applyStyle(); mapsSheet();
    },
  });
  const on = (id, fn) => { const el = $(id); if (el) el.onchange = fn; };
  on('m3d', (e) => { setS('terrain3d', e.target.checked); applyTerrain(); });
  on('mHill', (e) => setS('hillshade', e.target.checked, true));
  on('mCont', (e) => setS('contours', e.target.checked, true));
  on('mTracks', (e) => { setS('showSavedTracks', e.target.checked); refreshOverlays(); });
  on('mWpts', (e) => { setS('showWaypoints', e.target.checked); refreshOverlays(); });
  on('mCache', (e) => { setS('cacheWhileBrowsing', e.target.checked); tiles.configure({ cacheWhileBrowsing: S.cacheWhileBrowsing }); });
  on('mCustom', (e) => { setS('customSatUrl', e.target.value.trim()); tiles.configure({ customUrl: S.customSatUrl }); applyStyle(); });
  on('uRepo', saveUpdateFields); on('uTok', saveUpdateFields);
  const op = $('mSatOp'); if (op) op.oninput = (e) => { S.satOpacity = +e.target.value; if (map.getLayer('satellite')) map.setPaintProperty('satellite', 'raster-opacity', S.satOpacity); store.saveSetting('satOpacity', S.satOpacity); };
  document.querySelectorAll('input[name=satsrc]').forEach((r) => (r.onchange = () => { setS('satSource', r.value); tiles.configure({ satSource: S.satSource }); applyStyle(); mapsSheet(); }));
  if ($('cacheCount')) tiles.cacheStats().then((n) => { if ($('cacheCount')) $('cacheCount').textContent = `${n.toLocaleString()} imagery & terrain tiles stored on this unit.`; });
  store.storageEstimate().then((e) => { if (e && $('mStore')) $('mStore').textContent = `Storage used ${gb(e.usage || 0)} of ${gb(e.quota || 0)} available to the app.`; });
}
function saveUpdateFields() {
  const r = $('uRepo'), t = $('uTok');
  if (r) setS('updateRepo', r.value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, ''));
  if (t && t.value && !t.value.startsWith('•')) setS('updateToken', t.value.trim());
  if (t && !t.value) setS('updateToken', '');
}

function areaSheet() {
  const b = map.getBounds();
  const bboxV = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const srcMax = tiles.satSource().maxzoom;
  const zooms = [12, 13, 14, 15, 16, 17, 18].filter((z) => z <= srcMax);
  let z = Math.min(srcMax, Math.max(13, Math.round(map.getZoom()) + 2));
  const est = () => {
    const sat = $('aSat').checked ? tiles.countTiles(bboxV, 0, z) : 0;
    const dem = $('aDem').checked ? tiles.countTiles(bboxV, 0, 12) : 0;
    $('aEst').textContent = `${(sat + dem).toLocaleString()} tiles · about ${gb(sat * tiles.AVG_BYTES.sat + dem * tiles.AVG_BYTES.dem)}${sat + dem > 120000 ? ' — large: zoom in or lower the detail' : ''}`;
  };
  openSheet('Download area for offline', `
    <p class="note">Downloads what is on screen now. Source: <b>${tiles.satSource().name}</b>.</p>
    <div class="field"><label>Name</label><input type="text" id="aName" value="Area ${state.areas.length + 1}"></div>
    <label class="toggle"><span>Satellite imagery</span><input type="checkbox" id="aSat" checked></label>
    <label class="toggle"><span>Terrain (3D, shading, contours, elevation)</span><input type="checkbox" id="aDem" checked></label>
    <div class="field" style="margin-top:10px"><label>Imagery detail (max zoom)</label><div class="seg" id="aZ">${zooms.map((v) => `<button data-z="${v}" class="${v === z ? 'on' : ''}">z${v}</button>`).join('')}</div></div>
    <p id="aEst"></p>
    <div class="btns"><button class="primary" data-a="start">⬇ Start download</button></div>`, {
    start: () => {
      const layers = [...($('aSat').checked ? ['sat'] : []), ...($('aDem').checked ? ['dem'] : [])];
      if (!layers.length) return;
      const area = { id: store.uid(), name: $('aName').value || 'Area', bbox: bboxV, maxZoom: z, demMaxZoom: 12, layers, source: S.satSource, tiles: 0, bytes: 0, created: Date.now() };
      runAreaDownload(area, false);
    },
  });
  $('aZ').onclick = (e) => { const v = e.target.closest('button')?.dataset.z; if (v) { z = +v; $('aZ').querySelectorAll('button').forEach((x) => x.classList.toggle('on', +x.dataset.z === z)); est(); } };
  $('aSat').onchange = est; $('aDem').onchange = est; est();
}
let areaAbort;
async function runAreaDownload(area, refresh) {
  if (!tiles.isOnline()) return toast('No internet connection — connect to download. Your existing offline data stays in use.');
  areaAbort = new AbortController();
  openSheet(`Downloading “${area.name}”`, `<div class="progress" id="dProg"><div></div></div><p id="dTxt">Starting…</p><p class="note">You can keep driving and using the map. Already-stored tiles are skipped, so an interrupted download resumes where it stopped.${refresh ? ' Updating replaces tiles only when the new copy downloads successfully.' : ''}</p><div class="btns"><button class="btn danger" data-a="cancel">Stop</button></div>`, {
    cancel: () => areaAbort.abort(),
  });
  const res = await tiles.downloadArea({
    bbox: area.bbox, layers: area.layers, maxZoom: area.maxZoom, demMaxZoom: area.demMaxZoom, signal: areaAbort.signal, force: refresh,
    onProgress: (p, s) => { const bar = document.querySelector('#dProg > div'); if (bar) bar.style.width = `${p * 100}%`; const t = $('dTxt'); if (t) t.textContent = `${s.done.toLocaleString()} / ${s.total.toLocaleString()} tiles · ${gb(s.bytes)}${s.failed ? ` · ${s.failed} failed` : ''}`; },
  });
  area.tiles = res.total; area.bytes = refresh ? Math.max(area.bytes, res.bytes) : res.bytes; area.failed = res.failed; area.updated = Date.now();
  await store.put('areas', area);
  if (!state.areas.some((a) => a.id === area.id)) state.areas.push(area);
  toast(res.cancelled ? `Stopped — ${res.done.toLocaleString()} tiles kept; tap Update to resume` : `“${area.name}” ready offline${res.failed ? ` (${res.failed} tiles could not be fetched)` : ''}`, 6000);
  mapsTab = 'imagery'; mapsSheet(); updateNoMapHint();
}

async function importMapFile([file]) {
  if (!file) return;
  if (!/\.pmtiles$/i.test(file.name) && !(await confirmBox(`“${esc(file.name)}” is not a .pmtiles file. MBTiles must be converted first (see guide). Try anyway?`))) return;
  openSheet('Importing map', '<div class="progress" id="iProg"><div></div></div><p class="note">Copying into the app so it works without the USB stick…</p>');
  const res = await store.importMapFile(file, (p) => { const bar = document.querySelector('#iProg > div'); if (bar) bar.style.width = `${p * 100}%`; });
  try {
    const meta = await registerMap(res.name);
    await loadMaps(); applyStyle();
    const b = meta.bounds; unfollow(); map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 20, duration: 0 });
    toast(res.persisted ? `“${res.name}” installed for offline use (${meta.kind})` : 'Map loaded for this session only — not enough storage to keep a copy', 6000);
  } catch (e) { await store.deleteMapFile(res.name); toast(`Could not read map file: ${e.message}`, 6000); }
  mapsTab = 'updates'; mapsSheet();
}

/* ---------- Tools ---------- */
function toolsSheet() {
  openSheet('Tools', `<div class="toolgrid">
    <button data-a="plan"><i>⇢</i>Route planner</button>
    <button data-a="measure"><i>📏</i>Measure</button>
    <button data-a="tilt"><i>⛰</i>Pitch &amp; roll</button>
    <button data-a="wx"><i>🌡</i>Weather</button>
    <button data-a="fuel"><i>⛽</i>Fuel range</button>
    <button data-a="sun"><i>☀</i>Sun &amp; time</button>
    <button data-a="sos" class="sos"><i>SOS</i>Emergency</button>
    <button data-a="settings"><i>⚙</i>Settings</button>
    <button data-a="backup"><i>💾</i>Backup</button>
    <button data-a="report"><i>🧪</i>Test report</button>
  </div>`, {
    report: reportSheet,
    plan: () => startPlan('route'), measure: () => startPlan('measure'), tilt: tiltSheet, wx: weatherSheet, fuel: fuelSheet, sun: sunSheet,
    sos: sosSheet, settings: settingsSheet,
    backup: () => openSheet('Backup & restore', `<p class="note">Saves all trips, routes, waypoints and settings into one file (Documents/Rimal). Restore it on this or another unit via Trips → Import.</p><div class="btns"><button class="primary" data-a="b">💾 Create backup</button><button class="btn" data-a="r">Restore from file</button></div>`, { b: backup, r: () => pickFile('.json,application/json', importFiles, false) }),
  });
}

async function refreshWeather(force = false) {
  const f = state.fix; const p = f ? [f.lon, f.lat] : [map.getCenter().lng, map.getCenter().lat];
  state.weather = await weather(p[0], p[1], force);
  return state.weather;
}
async function weatherSheet() {
  openSheet('Weather', '<p class="note">Loading…</p>');
  const w = await refreshWeather(true);
  if (!w) return openSheet('Weather', '<div class="empty">No forecast yet. It is fetched automatically whenever the unit is online and then kept for offline use.</div>');
  const c = w.data.current, d = w.data.daily;
  const age = (Date.now() - w.at) / 60000;
  openSheet('Weather', `
    <p class="note">${age < 5 ? 'Live' : `Saved forecast from ${fmtDuration(age * 60)} ago — offline`} · ${fmtCoord(w.at_pos[0], w.at_pos[1], 'dd')}</p>
    <div class="grid stats">
      <div class="cell"><label>Now</label><b>${Math.round(c.temperature_2m)}°C</b></div>
      <div class="cell"><label>Sky</label><b>${WX[c.weather_code] || '—'}</b></div>
      <div class="cell"><label>Wind</label><b>${Math.round(c.wind_speed_10m)} km/h ${cardinal(c.wind_direction_10m)}</b></div>
      <div class="cell"><label>Gusts</label><b style="color:${c.wind_gusts_10m > 50 ? 'var(--danger)' : ''}">${Math.round(c.wind_gusts_10m)} km/h</b></div>
      <div class="cell"><label>Visibility</label><b>${c.visibility != null ? fmtDist(c.visibility, S.units) : '—'}</b></div>
    </div>
    ${c.wind_gusts_10m > 50 ? '<p class="warnbox">Strong gusts — risk of blowing sand and low visibility.</p>' : ''}
    <h3>Next days</h3>
    ${d.time.map((t, i) => `<div class="row"><div class="grow"><div class="title">${new Date(t).toLocaleDateString(undefined, { weekday: 'long' })}</div><div class="sub">${Math.round(d.temperature_2m_min[i])}–${Math.round(d.temperature_2m_max[i])}°C · gusts ${Math.round(d.wind_gusts_10m_max[i])} km/h · rain ${d.precipitation_sum[i]} mm</div></div></div>`).join('')}
    <p class="note">Forecast: Open-Meteo.com</p>`);
}
function sunSheet() {
  const f = state.fix; const p = f ? [f.lon, f.lat] : [map.getCenter().lng, map.getCenter().lat];
  const t = sunTimes(p[0], p[1]), tm = sunTimes(p[0], p[1], new Date(Date.now() + 86400000));
  openSheet('Sun & time', `<div class="grid stats">
    <div class="cell"><label>First light</label><b>${hhmm(t.dawn)}</b></div><div class="cell"><label>Sunrise</label><b>${hhmm(t.sunrise)}</b></div>
    <div class="cell"><label>Sunset</label><b>${hhmm(t.sunset)}</b></div><div class="cell"><label>Last light</label><b>${hhmm(t.dusk)}</b></div>
    <div class="cell"><label>Daylight left</label><b>${t.sunset > Date.now() ? fmtDuration((t.sunset - Date.now()) / 1000) : 'after sunset'}</b></div><div class="cell"><label>Tomorrow sunrise</label><b>${hhmm(tm.sunrise)}</b></div></div>
    <label class="toggle"><span>Warn me 45 min before sunset</span><input type="checkbox" id="sunW" ${S.sunsetWarn ? 'checked' : ''}></label>`);
  $('sunW').onchange = (e) => setS('sunsetWarn', e.target.checked);
}
function sosSheet() {
  const f = state.fix;
  if (!f) return openSheet('Emergency', '<p class="warnbox">No GPS fix yet. Move to open sky.</p><p>Saudi emergency: <b>911</b> · Red Crescent <b>997</b></p>');
  const town = nearest([f.lon, f.lat], 'place', 1)[0];
  const text = `EMERGENCY - my location: ${fmtCoord(f.lon, f.lat, 'dd')} (${fmtCoord(f.lon, f.lat, 'dms')}). https://maps.google.com/?q=${f.lat.toFixed(6)},${f.lon.toFixed(6)}${town ? ` ~${fmtDist(town[0])} ${cardinal(bearing(town[1], [f.lon, f.lat]))} of ${town[1][3] || town[1][4]}` : ''}`;
  openSheet('Emergency', `
    <div class="sosbox"><div class="big2">${fmtCoord(f.lon, f.lat, 'dd')}</div><div>${fmtCoord(f.lon, f.lat, 'dms')}</div><div>${fmtCoord(f.lon, f.lat, 'utm')}</div>
    <div>Altitude ${fmtAlt(f.alt ?? state.ground, S.units)} · accuracy ±${fmtDist(f.acc)}</div>
    ${town ? `<div>${fmtDist(town[0], S.units)} ${cardinal(bearing(town[1], [f.lon, f.lat]))} of <b>${esc(town[1][3] || town[1][4])}</b></div>` : ''}</div>
    <div class="btns"><a class="primary btnlink" href="tel:911">📞 911</a><a class="btn btnlink" href="tel:997">Red Crescent 997</a><a class="btn btnlink" href="sms:?body=${encodeURIComponent(text)}">✉ Send location by SMS</a><button class="btn" data-a="wp">⚑ Save this spot</button></div>
    <p class="note">Read the coordinates to the operator. SMS works with very weak signal — try it even with one bar.</p>`, {
    wp: () => addWaypoint(f.lon, f.lat, f.alt, 'Emergency position'),
  });
}

/* ---------- Field-test report ---------- */
function reportSheet() {
  openSheet('Test report', `
    <p class="note">Use this after a test drive or when something goes wrong. It saves one file with the device details, GPS quality, sensors, maps, speed and recent errors — no trips or personal data beyond your current position.</p>
    <div class="field"><label>What happened? (optional)</label><textarea id="rNote" placeholder="e.g. map went blank after 20 min near Al Thumamah; GPS jumped; screen froze when…"></textarea></div>
    <div class="btns"><button class="primary" data-a="make">🧪 Create report</button></div>
    <pre id="rSum" class="note" style="white-space:pre-wrap"></pre>`, {
    make: async () => {
      $('rSum').textContent = 'Collecting (3 s)…';
      const r = await buildReport({ state, S, map, tiles, attitude, native }, $('rNote').value);
      const name = `rimal-report-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
      const where = await native.saveText(name, JSON.stringify(r, null, 1));
      $('rSum').textContent = reportSummary(r) + `\n\nSaved: ${where || name}`;
      toast(where ? `Report saved to ${where}` : 'Report downloaded', 6000);
    },
  });
}

/* ---------- Settings ---------- */
function settingsSheet() {
  openSheet('Settings', `
    <div class="field"><label>Units</label>${segHtml('units', [['metric', 'Metric (km, m)'], ['imperial', 'Imperial (mi, ft)']])}</div>
    <div class="field"><label>Coordinate format</label>${segHtml('coordFormat', [['dd', 'Decimal'], ['ddm', 'Deg Min'], ['dms', 'DMS'], ['utm', 'UTM']])}</div>
    <div class="field"><label>Off-track alarm distance</label>${segHtml('offRouteAlert', [[50, '50 m'], [100, '100 m'], [200, '200 m'], [500, '500 m']])}</div>
    <div class="field"><label>Arrival radius</label>${segHtml('arrivalRadius', [[25, '25 m'], [50, '50 m'], [100, '100 m'], [250, '250 m']])}</div>
    <div class="field"><label>Speed alert</label>${segHtml('speedAlert', [[0, 'Off'], [60, '60'], [80, '80'], [100, '100'], [120, '120'], [140, '140 km/h']])}</div>
    <div class="field"><label>Track detail (point spacing)</label>${segHtml('minPointDist', [[3, 'High · 3 m'], [8, 'Normal · 8 m'], [20, 'Low · 20 m']])}</div>
    <label class="toggle"><span>Auto-record a trip when the car starts moving</span><input type="checkbox" id="sAuto" ${S.autoRecord ? 'checked' : ''}></label>
    <label class="toggle"><span>Demo GPS (simulated drive — for trying the app indoors)</span><input type="checkbox" id="sDemo" ${S.demoGps ? 'checked' : ''}></label>
    <p class="note">Tip: tap any data box on the left to choose what it shows.</p>
    <p class="note" style="margin-top:16px">Rimal Off-Road Navigator v2.0 · Map data © OpenStreetMap contributors · Imagery: ${tiles.satSource().attribution.replace(/<[^>]+>/g, '')} · Terrain: Mapzen/AWS · Weather: Open-Meteo.</p>`, {
    set: (id) => { const [k, v] = id.split(':'); setS(k, isNaN(+v) ? v : +v); updateDash(); settingsSheet(); },
  });
  $('sAuto').onchange = (e) => setS('autoRecord', e.target.checked);
  $('sDemo').onchange = (e) => { setS('demoGps', e.target.checked); gps.start(S.demoGps); toast(S.demoGps ? 'Demo GPS on' : 'Using real GPS'); };
}

function setS(k, v, restyle = false) {
  S[k] = v; store.saveSetting(k, v);
  document.body.classList.toggle('night', !!S.night);
  if (restyle) applyStyle();
}

/* =========================================================
   Helpers + boot
   ========================================================= */
function pickFile(accept, cb, multiple) {
  const inp = $('fileInput');
  // Android's picker greys out unknown extensions like .pmtiles, so allow any file there.
  inp.value = ''; inp.accept = native.isNative ? '*/*' : accept; inp.multiple = !!multiple;
  inp.onchange = () => cb([...inp.files]);
  inp.click();
}
function bbox(coords) {
  let a = [Infinity, Infinity], b = [-Infinity, -Infinity];
  for (const c of coords) { a = [Math.min(a[0], c[0]), Math.min(a[1], c[1])]; b = [Math.max(b[0], c[0]), Math.max(b[1], c[1])]; }
  return [a, b];
}
function unfollow() { state.follow = false; $('bFollow').classList.remove('on'); }

function checkEngine() {
  const gl = document.createElement('canvas').getContext('webgl2');
  const m = navigator.userAgent.match(/Chrome\/(\d+)/);
  const ver = m ? +m[1] : 999;
  if (gl && ver >= 100 && typeof structuredClone === 'function' && typeof OffscreenCanvas === 'function') return true;
  $('noMap').hidden = false;
  $('noMap').innerHTML = `<h2>Web engine too old</h2><p>This head unit's Android System WebView (version ${m ? m[1] : '?'}) can't draw the map. Update <b>Android System WebView</b> or <b>Chrome</b> to version 100 or newer, then reopen Rimal. GPS, tracking and navigation may still work.</p>`;
  return false;
}

const withTimeout = (p, ms, label, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => { console.warn(`${label} took over ${ms / 1000}s — continuing without it`); r(fallback); }, ms))]);

async function boot() {
  state.engineOk = checkEngine();
  S = await withTimeout(store.loadSettings(), 8000, 'Loading settings', { ...store.DEFAULTS });
  if (!S.updateRepo && import.meta.env.VITE_UPDATE_REPO) { S.updateRepo = import.meta.env.VITE_UPDATE_REPO; store.saveSetting('updateRepo', S.updateRepo); }
  document.body.classList.toggle('night', !!S.night);
  tiles.configure({ satSource: S.satSource, customUrl: S.customSatUrl, cacheWhileBrowsing: S.cacheWhileBrowsing });
  [state.tracks, state.waypoints, state.areas] = await withTimeout(Promise.all([store.getAll('tracks'), store.getAll('waypoints'), store.getAll('areas')]), 8000, 'Loading trips', [[], [], []]);
  await withTimeout(loadMaps(), 12000, 'Opening offline maps', null);

  map = new maplibregl.Map({
    container: 'map', style: buildStyle(), center: S.lastView.center, zoom: S.lastView.zoom,
    attributionControl: { compact: true }, maxPitch: 75, dragRotate: true, fadeDuration: 0,
    cancelPendingTileRequestsWhileZooming: true,
  });
  map.addControl(new maplibregl.ScaleControl({ unit: S.units === 'imperial' ? 'imperial' : 'metric' }), 'bottom-left');
  map.once('style.load', () => { applyTerrain(); refreshOverlays(); });
  updateNoMapHint();
  window.__rimal = { map, state, S, gps, tiles, packs, store, native, checkUpdates, setS, applyStyle, stopRecording, startRoute, startGoto, refreshWeather, attitude, buildReport: (note) => buildReport({ state, S, map, tiles, attitude, native }, note) };

  // Log map errors as readable text (default handler prints "[object Object]" in Android logs).
  map.on('error', (e) => console.warn('MapError', e.sourceId || '', e.error?.message || String(e.error)));
  map.on('dragstart', (e) => { if (e.originalEvent) unfollow(); });
  map.on('rotate', () => { $('bCompass').querySelector('svg').style.transform = `rotate(${-map.getBearing()}deg)`; });
  map.on('moveend', () => { const c = map.getCenter(); S.lastView = { center: [c.lng, c.lat], zoom: map.getZoom() }; store.saveSetting('lastView', S.lastView); });
  map.on('click', (e) => {
    if (state.plan) { state.plan.points.push([e.lngLat.lng, e.lngLat.lat]); refreshPlan(); renderPlanBar(); return; }
    const f = map.queryRenderedFeatures(e.point, { layers: ['wpts', 'rimal-pois'].filter((l) => map.getLayer(l)) })[0];
    if (!f) return;
    if (f.layer.id === 'wpts') { const w = state.waypoints.find((x) => x.id === f.properties.id); if (w) showPointPopup({ lng: w.lon, lat: w.lat }, w.name, w); }
    else showPointPopup({ lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }, f.properties.name);
  });
  map.on('contextmenu', (e) => { if (!state.plan) showPointPopup(e.lngLat, 'Selected point'); });
  let lp;
  map.on('touchstart', (e) => { if (e.points.length !== 1 || state.plan) return; const ll = e.lngLat; lp = setTimeout(() => showPointPopup(ll, 'Selected point'), 650); });
  ['touchend', 'touchmove', 'touchcancel', 'movestart'].forEach((ev) => map.on(ev, () => clearTimeout(lp)));

  $('bRec').onclick = recMenu;
  $('bMark').onclick = markHere;
  $('bGoto').onclick = gotoSheet;
  $('bBack').onclick = trackBackSheet;
  $('bSearch').onclick = () => searchSheet();
  $('bLib').onclick = tripsSheet;
  $('bMaps').onclick = () => mapsSheet();
  $('bTools').onclick = toolsSheet;
  $('noMapBtn').onclick = () => { mapsTab = 'updates'; mapsSheet(); };
  $('navStop').onclick = stopNav;
  $('planUndo').onclick = () => { state.plan?.points.pop(); refreshPlan(); renderPlanBar(); };
  $('planSave').onclick = savePlan;
  $('planGo').onclick = () => { const p = state.plan; stopPlan(); startRoute(p.points, p.mode === 'measure' ? 'measured line' : 'planned route', false, 'Route: '); };
  $('planClose').onclick = stopPlan;
  $('bZoomIn').onclick = () => map.zoomIn();
  $('bZoomOut').onclick = () => map.zoomOut();
  $('b3d').onclick = () => { setS('terrain3d', !S.terrain3d); applyTerrain(); toast(S.terrain3d ? '3D terrain' : '2D map'); };
  $('bLayer').onclick = () => {
    const order = ['hybrid', 'satellite', 'topo'];
    let next = order[(order.indexOf(S.mapMode) + 1) % 3];
    if (next === 'topo' && !S.baseMap) next = 'hybrid';
    setS('mapMode', next, true);
    toast({ hybrid: 'Satellite + roads', satellite: 'Satellite only', topo: 'Topo map' }[next]);
  };
  $('bFollow').onclick = () => {
    state.follow = true; $('bFollow').classList.add('on');
    if (state.fix) map.easeTo({ center: [state.fix.lon, state.fix.lat], zoom: Math.max(map.getZoom(), 14) });
    else toast('Waiting for GPS fix…');
  };
  $('bCompass').onclick = () => {
    S.headingUp = !S.headingUp; store.saveSetting('headingUp', S.headingUp);
    $('bCompass').classList.toggle('hu', S.headingUp);
    if (!S.headingUp) map.easeTo({ bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
    toast(S.headingUp ? 'Track-up' : 'North-up');
  };
  $('fields').onclick = (e) => { const c = e.target.closest('[data-slot]'); if (c) fieldPicker(+c.dataset.slot); };
  $('tilt').onclick = tiltSheet;
  $('bCompass').classList.toggle('hu', S.headingUp);
  $('bFollow').classList.add('on');

  renderFields();
  attitude.setCalibration(S.tiltCal);
  attitude.start();
  $('tilt').hidden = true; // shown once the sensor reports
  await restoreLive();
  updateDash();
  setInterval(() => { updateDash(); store.saveSetting('odometer', S.odometer); }, 5000);
  native.keepAwake();
  gps.start(S.demoGps);

  // Status line for automated device tests (Android logcat / iOS console).
  const status = () => console.log('RIMAL_STATUS ' + JSON.stringify({ platform: native.platform, engine: state.engineOk, webgl2: !!document.createElement('canvas').getContext('webgl2'), opfs: !!navigator.storage?.getDirectory, fix: state.fix && [+state.fix.lon.toFixed(4), +state.fix.lat.toFixed(4), state.fix.acc], maps: Object.keys(state.maps).length, styleLoaded: map.isStyleLoaded(), zoom: +map.getZoom().toFixed(1), sensor: attitude.available }));
  setTimeout(status, 20000); setTimeout(status, 60000);

  // Automatic map updates: shortly after start, whenever the connection comes back, and every 6 hours.
  setTimeout(() => checkUpdates(false), 8000);
  window.addEventListener('online', () => { tiles.resetOnline(); setTimeout(() => checkUpdates(false), 3000); refreshWeather(); updateNoMapHint(); });
  window.addEventListener('offline', updateNoMapHint);
  setInterval(() => { if (Date.now() - S.lastUpdateCheck > 6 * 3600e3) checkUpdates(false); refreshWeather(); }, 15 * 60000);
}

if (!native.isNative && 'serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});

boot().then(() => { window.__rimalReady = true; }).catch((e) => { console.error(e); window.__rimalBootError?.('Startup: ' + (e?.stack || e?.message || e)); window.__rimalShowBootPanel?.('startup error'); toast('Startup error: ' + e.message, 10000); });
