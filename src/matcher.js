// Road matching ("snap to road") and self-learned GPS correction — all offline.
//
// 1. On streets, each GPS fix is moved onto the nearest road from the offline street map whose direction
//    matches the way the car is heading. This removes the 20–40 m sideways error of weak car-screen GPS
//    (tracks over houses, cut roundabouts).
// 2. Each time a fix is snapped, the sideways error is a measurement of the GPS's current bias. Combining
//    roads of different directions gives the full bias vector (east/north). While it is stable, Rimal applies
//    it to every fix — also off-road in the desert, where there is no road to snap to.

const M_LAT = 110540, M_LON = 111320;
const toXY = (lon, lat, o) => [(lon - o[0]) * M_LON * Math.cos(o[1] * Math.PI / 180), (lat - o[1]) * M_LAT];
const toLL = (x, y, o) => [o[0] + x / (M_LON * Math.cos(o[1] * Math.PI / 180)), o[1] + y / M_LAT];

export class RoadMatcher {
  constructor(getRoads) {
    this.getRoads = getRoads;       // (lon, lat) => array of LineString coordinate arrays near that point
    this.segs = []; this.origin = null; this.cacheAt = null;
    this.lastWay = null;
    this.stats = { fixes: 0, snapped: 0 };
  }
  // Collect road segments within ~400 m into a local metric frame (refreshed after moving 150 m).
  load(lon, lat) {
    if (this.cacheAt && Math.hypot(...toXY(lon, lat, this.cacheAt)) < 150 && this.segs.length) return;
    if (!this.segs.length && this.tried && Date.now() - this.tried < 10000 && this.cacheAt && Math.hypot(...toXY(lon, lat, this.cacheAt)) < 300) return; // no roads here (desert): look again in 10 s
    this.tried = Date.now();
    const lines = this.getRoads(lon, lat) || [];
    this.origin = [lon, lat]; this.cacheAt = [lon, lat];
    const segs = [];
    for (const { coords, id } of lines) {
      for (let i = 1; i < coords.length; i++) {
        const a = toXY(coords[i - 1][0], coords[i - 1][1], this.origin), b = toXY(coords[i][0], coords[i][1], this.origin);
        if (Math.min(Math.abs(a[0]), Math.abs(b[0])) > 450 && Math.sign(a[0]) === Math.sign(b[0])) continue;
        if (Math.min(Math.abs(a[1]), Math.abs(b[1])) > 450 && Math.sign(a[1]) === Math.sign(b[1])) continue;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 0.5) continue;
        segs.push({ a, b, len, ux: (b[0] - a[0]) / len, uy: (b[1] - a[1]) / len, id });
      }
    }
    this.segs = segs;
  }
  reset() { this.segs = []; this.cacheAt = null; this.tried = 0; }
  // Returns { lon, lat, dist, normal:[nx,ny], offset } or null when no road fits.
  match(lon, lat, heading, speed, acc) {
    this.stats.fixes++;
    this.load(lon, lat);
    if (!this.segs.length) return null;
    const p = toXY(lon, lat, this.origin);
    const maxD = Math.max(18, Math.min(45, (acc || 20) * 1.6));
    const useHeading = heading != null && speed != null && speed > 2.5;
    const hx = useHeading ? Math.sin(heading * Math.PI / 180) : 0, hy = useHeading ? Math.cos(heading * Math.PI / 180) : 0;
    let best = null;
    for (const s of this.segs) {
      let t = ((p[0] - s.a[0]) * s.ux + (p[1] - s.a[1]) * s.uy);
      t = Math.max(0, Math.min(s.len, t));
      const q = [s.a[0] + s.ux * t, s.a[1] + s.uy * t];
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (d > maxD) continue;
      let score = d;
      if (useHeading) {
        const cos = Math.abs(hx * s.ux + hy * s.uy); // road works both ways
        if (cos < 0.77) continue;                    // more than ~40° off the road's direction
        score += (1 - cos) * 40;
      }
      if (s.id != null && s.id === this.lastWay) score -= 4; // stay on the same road through junction noise
      if (!best || score < best.score) best = { score, q, d, s };
    }
    if (!best) { this.lastWay = null; return null; }
    this.lastWay = best.s.id;
    this.stats.snapped++;
    const [mlon, mlat] = toLL(best.q[0], best.q[1], this.origin);
    // Signed sideways offset from the GPS fix to the road (positive along the road's left normal).
    const nx = -best.s.uy, ny = best.s.ux;
    const offset = (best.q[0] - p[0]) * nx + (best.q[1] - p[1]) * ny;
    return { lon: mlon, lat: mlat, dist: best.d, normal: [nx, ny], offset, straight: best.s.len > 25 };
  }
}

// Learns the GPS's current bias (metres east, north) from sideways offsets on roads of different directions.
export class BiasLearner {
  constructor(saved) {
    this.halfLife = 8 * 60e3;   // older measurements count for less (satellites move, the bias drifts)
    this.maxAge = 30 * 60e3;    // forget the correction 30 min after the last road measurement
    Object.assign(this, { A: [0, 0, 0], B: [0, 0], w: 0, n: 0, at: 0, bias: null }, saved && Date.now() - saved.at < this.maxAge ? saved : {});
  }
  decay(now) {
    if (!this.at) { this.at = now; return; }
    const k = Math.pow(0.5, (now - this.at) / this.halfLife);
    this.A = this.A.map((v) => v * k); this.B = this.B.map((v) => v * k); this.w *= k; this.at = now;
  }
  // normal: unit vector across the road; offset: metres from GPS fix to road along that normal.
  add(normal, offset, now = Date.now()) {
    if (Math.abs(offset) > 40) return;
    this.decay(now);
    const [nx, ny] = normal;
    this.A[0] += nx * nx; this.A[1] += nx * ny; this.A[2] += ny * ny;
    this.B[0] += nx * offset; this.B[1] += ny * offset;
    this.w += 1; this.n++;
    this.solve();
  }
  solve() {
    const [a, b, c] = this.A, det = a * c - b * b;
    // Need enough samples on at least two road directions (det measures how well both axes are covered).
    if (this.w < 12 || det < 0.08 * this.w * this.w) { this.bias = null; return; }
    const ex = (c * this.B[0] - b * this.B[1]) / det, ny = (a * this.B[1] - b * this.B[0]) / det;
    this.bias = Math.hypot(ex, ny) <= 60 ? [ex, ny] : null;
  }
  current(now = Date.now()) { return this.bias && now - this.at < this.maxAge ? this.bias : null; }
  apply(lon, lat) {
    const b = this.current(); if (!b) return [lon, lat];
    return [lon + b[0] / (M_LON * Math.cos(lat * Math.PI / 180)), lat + b[1] / M_LAT];
  }
  toJSON() { return { A: this.A, B: this.B, w: this.w, n: this.n, at: this.at, bias: this.bias }; }
}
