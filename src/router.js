// Offline road routing over Rimal's "Road directions" pack (RIMALRT1, built by scripts/build_routing_pack.py).
// The file is read with random access: only the 0.25° cells a route passes through are loaded.
import { gunzipSync, strFromU8 } from 'fflate';

const R = 6371008.8, RAD = Math.PI / 180;
const hav = (lon1, lat1, lon2, lat2) => { const a = 0.5 - Math.cos((lat2 - lat1) * RAD) / 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * (1 - Math.cos((lon2 - lon1) * RAD)) / 2; return 2 * R * Math.asin(Math.sqrt(Math.min(1, a))); };
const bearing = (a, b) => { const y = Math.sin((b[0] - a[0]) * RAD) * Math.cos(b[1] * RAD), x = Math.cos(a[1] * RAD) * Math.sin(b[1] * RAD) - Math.sin(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.cos((b[0] - a[0]) * RAD); return (Math.atan2(y, x) / RAD + 360) % 360; };
const LOCAL = 1 << 20;

class Heap { // min-heap of [cost, key]
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(c, key) { const k = this.k, v = this.v; let i = k.length; k.push(c); v.push(key); while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= c) break; k[i] = k[p]; v[i] = v[p]; i = p; } k[i] = c; v[i] = key; }
  pop() { const k = this.k, v = this.v, top = v[0], tc = k[0], lc = k.pop(), lv = v.pop(); if (k.length) { let i = 0; const n = k.length; for (;;) { let l = 2 * i + 1; if (l >= n) break; if (l + 1 < n && k[l + 1] < k[l]) l++; if (k[l] >= lc) break; k[i] = k[l]; v[i] = v[l]; i = l; } k[i] = lc; v[i] = lv; } return [tc, top]; }
}

export class RoadRouter {
  constructor(file) { this.file = file; this.cells = new Map(); this.lru = []; }
  async open() {
    const head = new Uint8Array(await this.file.slice(0, 12).arrayBuffer());
    if (strFromU8(head.subarray(0, 8)) !== 'RIMALRT1') throw new Error('not a Rimal road-directions file');
    const len = new DataView(head.buffer).getUint32(8, true);
    this.index = JSON.parse(strFromU8(gunzipSync(new Uint8Array(await this.file.slice(12, 12 + len).arrayBuffer()))));
    this.base = 12 + len;
    this.speeds = this.index.classes.map((c) => this.index.speeds[c] / 3.6); // m/s
    this.vmax = Math.max(...this.speeds);
    return this;
  }
  get bbox() { return this.index.bbox; }
  cidOf(lon, lat) { const { bbox, cell, nx, ny } = this.index; const cx = Math.floor((lon - bbox[0]) / cell), cy = Math.floor((lat - bbox[1]) / cell); if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) return -1; return cy * nx + cx; }
  async cell(cid) {
    if (this.cells.has(cid)) return this.cells.get(cid);
    const ent = this.index.cells[cid];
    if (!ent) { this.cells.set(cid, null); return null; }
    const raw = gunzipSync(new Uint8Array(await this.file.slice(this.base + ent[0], this.base + ent[0] + ent[1]).arrayBuffer()));
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const n = dv.getUint32(0, true), e = dv.getUint32(4, true), nc = dv.getUint32(8, true);
    let p = 16;
    const take = (T, count) => { const bytes = count * T.BYTES_PER_ELEMENT; const out = new T(raw.slice(p, p + bytes).buffer); p += bytes; return out; };
    const c = { lon: take(Int32Array, n), lat: take(Int32Array, n), es: take(Uint32Array, n + 1), to: take(Uint32Array, e), len: take(Uint32Array, e), gs: take(Uint32Array, e + 1), xy: take(Int32Array, nc * 2), name: take(Uint16Array, e), cls: take(Uint8Array, e), fl: take(Uint8Array, e) };
    this.cells.set(cid, c);
    this.lru.push(cid); if (this.lru.length > 400) { const old = this.lru.shift(); this.cells.delete(old); }
    return c;
  }
  async nodeLL(key) { const c = await this.cell(Math.floor(key / LOCAL)); const i = key % LOCAL; return [c.lon[i] / 1e6, c.lat[i] / 1e6]; }
  async hasEdge(fromKey, toKey) { const c = await this.cell(Math.floor(fromKey / LOCAL)); if (!c) return false; const i = fromKey % LOCAL; for (let e = c.es[i]; e < c.es[i + 1]; e++) if (c.to[e] === toKey) return true; return false; }
  edgePoints(c, from, e) {
    const pts = [[c.lon[from] / 1e6, c.lat[from] / 1e6]];
    for (let g = c.gs[e]; g < c.gs[e + 1]; g++) pts.push([c.xy[2 * g] / 1e6, c.xy[2 * g + 1] / 1e6]);
    return pts;
  }
  /** Nearest road to a point: { key (start node of the edge), e, pointIndex, dist, snapped:[lon,lat], along, edgeLen } searching up to maxDist m. */
  async nearest(lon, lat, maxDist = 2500) {
    const { cell } = this.index;
    const r = Math.ceil((maxDist / 111000) / cell);
    const c0 = this.cidOf(lon, lat); if (c0 < 0) return null;
    const nx = this.index.nx, cx0 = c0 % nx, cy0 = Math.floor(c0 / nx);
    const kx = 111320 * Math.cos(lat * RAD), ky = 110540;
    let best = null;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const cid = (cy0 + dy) * nx + cx0 + dx; if (cy0 + dy < 0 || cx0 + dx < 0 || cx0 + dx >= nx) continue;
      const c = await this.cell(cid); if (!c) continue;
      for (let i = 0; i < c.lon.length; i++) {
        const nlon = c.lon[i] / 1e6, nlat = c.lat[i] / 1e6;
        if (Math.abs(nlon - lon) * kx > maxDist + 3000 || Math.abs(nlat - lat) * ky > maxDist + 3000) continue;
        for (let e = c.es[i]; e < c.es[i + 1]; e++) {
          const pts = this.edgePoints(c, i, e); pts.push(await this.nodeLL(c.to[e]));
          let along = 0;
          for (let s = 0; s < pts.length - 1; s++) {
            const ax = (pts[s][0] - lon) * kx, ay = (pts[s][1] - lat) * ky, bx = (pts[s + 1][0] - lon) * kx, by = (pts[s + 1][1] - lat) * ky;
            const dx2 = bx - ax, dy2 = by - ay, L2 = dx2 * dx2 + dy2 * dy2, segLen = Math.sqrt(L2);
            const u = L2 ? Math.max(0, Math.min(1, -(ax * dx2 + ay * dy2) / L2)) : 0;
            const d = Math.hypot(ax + u * dx2, ay + u * dy2);
            if (d <= maxDist && (!best || d < best.dist)) best = { key: Math.floor(cid) * LOCAL + i, cid, i, e, seg: s, dist: d, snapped: [lon + (ax + u * dx2) / kx, lat + (ay + u * dy2) / ky], along: along + u * segLen, edgeLen: c.len[e] / 10, to: c.to[e] };
            along += segLen;
          }
        }
      }
    }
    return best;
  }
  /**
   * Route from → to (lon/lat). Returns { coords, dist, time, steps:[{at, dist, type, text, name, bearing}], offroadEnd, offroadStart } or null.
   * options.avoidTracks: don't use desert tracks.
   */
  async route(from, to, { avoidTracks = false, maxNodes = 2_500_000, onProgress } = {}) {
    const [a, b] = await Promise.all([this.nearest(from[0], from[1]), this.nearest(to[0], to[1])]);
    if (!a || !b) return null;
    const speedOf = (cls, fl) => (avoidTracks && (fl & 2) ? 0.3 : this.speeds[cls]);
    // Start and destination on the same stretch of road: drive straight along it.
    if (a.cid === b.cid && a.e === b.e && (b.along >= a.along || (await this.hasEdge(a.to, a.key)))) {
      const c = await this.cell(a.cid);
      const pts = this.edgePoints(c, a.i, a.e); pts.push(await this.nodeLL(a.to));
      const mid = b.along >= a.along ? pts.slice(a.seg + 1, b.seg + 1) : pts.slice(b.seg + 1, a.seg + 1).reverse();
      const coords = [from, a.snapped, ...mid, b.snapped];
      const offroadEnd = b.dist > 60 ? b.dist : 0;
      if (b.dist > 5) coords.push(to);
      const total = coords.slice(1).reduce((s, q, i) => s + hav(coords[i][0], coords[i][1], q[0], q[1]), 0);
      const sp = speedOf(c.cls[a.e], c.fl[a.e]);
      return { coords, dist: total, time: Math.abs(b.along - a.along) / sp + offroadEnd / 4, steps: [{ at: to, dist: total, type: 'arrive', text: offroadEnd ? `Leave the road and continue ${Math.round(offroadEnd)} m off-road to the destination` : 'Arrive at the destination' }], offroadEnd, offroadStart: a.dist > 60 ? a.dist : 0, expanded: 0 };
    }
    // Start: both ends of the snapped edge, with the part of the edge still to drive.
    const g = new Map(), prev = new Map(), heap = new Heap();
    const ca = await this.cell(a.cid);
    const startSpeed = speedOf(ca.cls[a.e], ca.fl[a.e]);
    const toLL = await this.nodeLL(a.to);
    const h = (ll) => hav(ll[0], ll[1], to[0], to[1]) / this.vmax;
    // Moving forward along the snapped edge reaches its end node.
    g.set(a.to, (a.edgeLen - a.along) / startSpeed); prev.set(a.to, { from: -1, start: 'fwd' }); heap.push(g.get(a.to) + h(toLL), a.to);
    // Its start node too, if the road is two-way (reaching it costs the distance back).
    if (await this.hasEdge(a.to, a.key)) { g.set(a.key, a.along / startSpeed); prev.set(a.key, { from: -1, start: 'back' }); heap.push(g.get(a.key) + h([ca.lon[a.i] / 1e6, ca.lat[a.i] / 1e6]), a.key); }
    // Finish at the start of the destination edge (then drive along it), or at its end if it is two-way.
    const goalA = b.key, goalB = (await this.hasEdge(b.to, b.key)) ? b.to : -1;
    let found = null, expanded = 0;
    const done = new Set();
    while (heap.size) {
      const [, k] = heap.pop();
      if (done.has(k)) continue; done.add(k);
      if (k === goalA || k === goalB) { found = k; break; }
      if (++expanded > maxNodes) break;
      if (expanded % 20000 === 0) { onProgress?.(expanded); await new Promise((r) => setTimeout(r, 0)); }
      const cid = Math.floor(k / LOCAL), i = k % LOCAL;
      const c = await this.cell(cid); if (!c) continue;
      const gk = g.get(k);
      for (let e = c.es[i]; e < c.es[i + 1]; e++) {
        const v = c.to[e]; if (done.has(v)) continue;
        const ng = gk + (c.len[e] / 10) / speedOf(c.cls[e], c.fl[e]);
        if (ng < (g.get(v) ?? Infinity)) {
          g.set(v, ng); prev.set(v, { from: k, cid, e });
          const vc = Math.floor(v / LOCAL); const cv = await this.cell(vc);
          heap.push(ng + h([cv.lon[v % LOCAL] / 1e6, cv.lat[v % LOCAL] / 1e6]), v);
        }
      }
    }
    if (found == null) return null;
    // Rebuild the edge list.
    const edges = []; let k = found;
    while (prev.get(k) && prev.get(k).from !== -1) { const p = prev.get(k); edges.unshift(p); k = p.from; }
    const startMode = prev.get(k)?.start;
    // Geometry.
    const coords = [from];
    const cStart = await this.cell(a.cid);
    const snappedEdge = this.edgePoints(cStart, a.i, a.e); snappedEdge.push(await this.nodeLL(a.to));
    coords.push(a.snapped);
    if (startMode === 'fwd') coords.push(...snappedEdge.slice(a.seg + 1));
    else coords.push(...snappedEdge.slice(0, a.seg + 1).reverse());
    const steps = [];
    let dist = 0, prevName = null, prevBear = null, inRoundabout = false, rbExits = 0;
    for (const p of edges) {
      const c = await this.cell(p.cid); const i = p.from % LOCAL;
      const pts = this.edgePoints(c, i, p.e); pts.push(await this.nodeLL(c.to[p.e]));
      const name = c.name[p.e] === 0xFFFF ? '' : this.index.names[c.name[p.e]];
      const rb = !!(c.fl[p.e] & 1), outDeg = c.es[i + 1] - c.es[i];
      const bIn = bearing(pts[0], pts[1]);
      if (rb && !inRoundabout) { inRoundabout = true; rbExits = 0; steps.push({ at: pts[0], dist, type: 'roundabout', name: '', bearing: bIn }); }
      else if (inRoundabout && rb && outDeg > 1) rbExits++;
      else if (inRoundabout && !rb) { inRoundabout = false; const st = steps[steps.length - 1]; st.exit = rbExits + 1; st.name = name; }
      else if (prevBear != null && !rb) {
        let turn = ((bIn - prevBear + 540) % 360) - 180; // + right, - left
        const atJunction = outDeg > 1 || (name && name !== prevName);
        if (atJunction && Math.abs(turn) > 30) steps.push({ at: pts[0], dist, type: Math.abs(turn) > 150 ? 'uturn' : turn > 0 ? (turn > 120 ? 'sharp right' : 'right') : (turn < -120 ? 'sharp left' : 'left'), name, bearing: bIn });
        else if (atJunction && Math.abs(turn) > 12 && outDeg > 2) steps.push({ at: pts[0], dist, type: turn > 0 ? 'keep right' : 'keep left', name, bearing: bIn });
      }
      coords.push(...pts.slice(1));
      dist += c.len[p.e] / 10;
      prevName = name; prevBear = bearing(pts[pts.length - 2], pts[pts.length - 1]);
    }
    // Finish on the destination edge, then straight to the target if it is off the road.
    const cEnd = await this.cell(b.cid);
    // Leaving a roundabout onto the destination road itself.
    if (inRoundabout && !(cEnd.fl[b.e] & 1)) { const st = steps[steps.length - 1]; st.exit = rbExits + 1; st.name = cEnd.name[b.e] === 0xFFFF ? '' : this.index.names[cEnd.name[b.e]]; }
    const endEdge = this.edgePoints(cEnd, b.i, b.e); endEdge.push(await this.nodeLL(b.to));
    if (found === b.key) coords.push(...endEdge.slice(1, b.seg + 1)); else coords.push(...endEdge.slice(b.seg + 1, -1).reverse());
    coords.push(b.snapped);
    const offroadEnd = b.dist > 60 ? b.dist : 0;
    if (b.dist > 5) coords.push(to);
    const total = coords.slice(1).reduce((s, c, i) => s + hav(coords[i][0], coords[i][1], c[0], c[1]), 0);
    for (const s of steps) s.text = stepText(s);
    steps.push({ at: to, dist: total, type: 'arrive', text: offroadEnd ? `Leave the road and continue ${Math.round(offroadEnd)} m off-road to the destination` : 'Arrive at the destination' });
    return { coords, dist: total, time: g.get(found) + (offroadEnd / 4), steps, offroadEnd, offroadStart: a.dist > 60 ? a.dist : 0, expanded };
  }
}

const ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh'];
export function stepText(s) {
  const onto = s.name ? ` onto ${s.name}` : '';
  switch (s.type) {
    case 'roundabout': return `At the roundabout, take the ${ORD[(s.exit || 1) - 1] || s.exit + 'th'} exit${onto}`;
    case 'uturn': return `Make a U-turn${onto}`;
    case 'arrive': return 'Arrive at the destination';
    default: return `${s.type.startsWith('keep') ? s.type[0].toUpperCase() + s.type.slice(1) : 'Turn ' + s.type}${onto}`;
  }
}
