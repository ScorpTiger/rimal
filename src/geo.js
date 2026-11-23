// Geodesy helpers — all distances in metres, angles in degrees.
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function distance(a, b) {
  // a, b: [lon, lat]
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearing(a, b) {
  const φ1 = rad(a[1]), φ2 = rad(b[1]), Δλ = rad(b[0] - a[0]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export function destination(a, brg, dist) {
  const δ = dist / R, θ = rad(brg), φ1 = rad(a[1]), λ1 = rad(a[0]);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [((deg(λ2) + 540) % 360) - 180, deg(φ2)];
}

export function pathLength(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += distance(coords[i - 1], coords[i]);
  return d;
}

// Project p onto segment ab using a local equirectangular approximation (fine for < few km segments).
function projectOnSegment(p, a, b) {
  const k = Math.cos(rad(p[1]));
  const ax = a[0] * k, ay = a[1], bx = b[0] * k, by = b[1], px = p[0] * k, py = p[1];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { t, point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
}

/**
 * Locate a position relative to a route (array of [lon,lat]).
 * hint: previous segment index, to keep searches local and stop jumping between
 * overlapping out-and-back legs.
 */
export function locateOnRoute(p, route, cum, hint = null) {
  let best = { d: Infinity, i: 0, t: 0, point: route[0] };
  let from = 0, to = route.length - 1;
  if (hint != null) {
    from = Math.max(0, hint - 30);
    to = Math.min(route.length - 1, hint + 300);
  }
  const scan = (s, e) => {
    for (let i = s; i < e; i++) {
      const pr = projectOnSegment(p, route[i], route[i + 1]);
      const d = distance(p, pr.point);
      if (d < best.d) best = { d, i, t: pr.t, point: pr.point };
    }
  };
  scan(from, to);
  if (hint != null && best.d > 250) scan(0, route.length - 1); // lost — global search
  const along = cum[best.i] + distance(route[best.i], best.point);
  return { offRoute: best.d, segment: best.i, along, point: best.point, remaining: cum[cum.length - 1] - along };
}

export function cumulative(route) {
  const cum = [0];
  for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + distance(route[i - 1], route[i]));
  return cum;
}

// Point that is `ahead` metres further along the route from `along`.
export function pointAlong(route, cum, along) {
  const total = cum[cum.length - 1];
  if (along >= total) return route[route.length - 1];
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < along) i++;
  const seg = cum[i + 1] - cum[i] || 1;
  const t = (along - cum[i]) / seg;
  return [route[i][0] + (route[i + 1][0] - route[i][0]) * t, route[i][1] + (route[i + 1][1] - route[i][1]) * t];
}

/* ---------------- formatting ---------------- */

const CARD = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const cardinal = (b) => CARD[Math.round(((b % 360) + 360) % 360 / 22.5) % 16];

export function fmtDist(m, units = 'metric') {
  if (m == null || !isFinite(m)) return '—';
  if (units === 'imperial') {
    const mi = m / 1609.344;
    return mi < 0.2 ? `${Math.round(m * 3.28084)} ft` : `${mi < 10 ? mi.toFixed(2) : mi.toFixed(1)} mi`;
  }
  return m < 1000 ? `${Math.round(m)} m` : `${m < 10000 ? (m / 1000).toFixed(2) : (m / 1000).toFixed(1)} km`;
}

export function fmtSpeed(ms, units = 'metric') {
  if (ms == null || !isFinite(ms)) return '—';
  return units === 'imperial' ? `${Math.round(ms * 2.23694)}` : `${Math.round(ms * 3.6)}`;
}
export const speedUnit = (u) => (u === 'imperial' ? 'mph' : 'km/h');

export function fmtAlt(m, units = 'metric') {
  if (m == null || !isFinite(m)) return '—';
  return units === 'imperial' ? `${Math.round(m * 3.28084)} ft` : `${Math.round(m)} m`;
}

export function fmtDuration(sec) {
  if (sec == null || !isFinite(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s).padStart(2, '0')}s`;
}

function dms(v, pos, neg, minutesOnly) {
  const h = v >= 0 ? pos : neg;
  v = Math.abs(v);
  const d = Math.floor(v);
  const mf = (v - d) * 60;
  if (minutesOnly) return `${h}${d}° ${mf.toFixed(3)}'`;
  const m = Math.floor(mf);
  const s = (mf - m) * 60;
  return `${h}${d}° ${String(m).padStart(2, '0')}' ${s.toFixed(1)}"`;
}

export function fmtCoord(lon, lat, format = 'dd') {
  if (lon == null) return '—';
  switch (format) {
    case 'dms': return `${dms(lat, 'N', 'S')}  ${dms(lon, 'E', 'W')}`;
    case 'ddm': return `${dms(lat, 'N', 'S', true)}  ${dms(lon, 'E', 'W', true)}`;
    case 'utm': { const u = toUTM(lon, lat); return `${u.zone}${u.band} ${Math.round(u.e)}E ${Math.round(u.n)}N`; }
    default: return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  }
}

/* ---------------- UTM (WGS84) ---------------- */
export function toUTM(lon, lat) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const zone = Math.floor((lon + 180) / 6) + 1;
  const lon0 = rad((zone - 1) * 6 - 180 + 3);
  const φ = rad(lat), λ = rad(lon);
  const N = a / Math.sqrt(1 - e2 * Math.sin(φ) ** 2);
  const T = Math.tan(φ) ** 2, C = ep2 * Math.cos(φ) ** 2, A = Math.cos(φ) * (λ - lon0);
  const M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * φ
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * φ)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * φ)
    - (35 * e2 ** 3 / 3072) * Math.sin(6 * φ));
  const e = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
  let n = k0 * (M + N * Math.tan(φ) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24
    + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
  if (lat < 0) n += 10000000;
  const band = 'CDEFGHJKLMNPQRSTUVWXX'[Math.floor((lat + 80) / 8)] || 'Z';
  return { zone, band, e, n };
}

/* ---------------- coordinate parsing ---------------- */
/**
 * Accepts: "24.7136, 46.6753", "24.7136 46.6753", "N24 42.816 E46 40.518",
 * "24°42'49.0\"N 46°40'31.1\"E", Google Maps links (@lat,lon or q=lat,lon).
 * Returns [lon, lat] or null.
 */
export function parseCoord(input) {
  if (!input) return null;
  let s = input.trim();
  const g = s.match(/[@=](-?\d+\.\d+),\s*(-?\d+\.\d+)/);
  if (g) return valid(+g[2], +g[1]);
  s = s.replace(/[″"]/g, '"').replace(/[′’']/g, "'").replace(/º/g, '°');
  // DMS / DDM with hemisphere letters
  const part = /([NSEW])?\s*(\d+(?:\.\d+)?)\s*[°\s]\s*(?:(\d+(?:\.\d+)?)\s*['\s]?\s*)?(?:(\d+(?:\.\d+)?)\s*"?\s*)?([NSEW])?/gi;
  if (/[NSEW]/i.test(s) && /[°'\s]/.test(s)) {
    const vals = [];
    let m;
    while ((m = part.exec(s)) && vals.length < 2) {
      if (!m[2]) { part.lastIndex++; continue; }
      const hemi = (m[1] || m[5] || '').toUpperCase();
      let v = +m[2] + (m[3] ? +m[3] / 60 : 0) + (m[4] ? +m[4] / 3600 : 0);
      if (hemi === 'S' || hemi === 'W') v = -v;
      vals.push({ v, hemi });
    }
    if (vals.length === 2) {
      let lat = vals[0], lon = vals[1];
      if ('EW'.includes(lat.hemi) && lat.hemi) [lat, lon] = [lon, lat];
      return valid(lon.v, lat.v);
    }
  }
  const nums = s.match(/-?\d+(?:\.\d+)?/g);
  if (nums && nums.length === 2) {
    let lat = +nums[0], lon = +nums[1];
    // Users in KSA sometimes paste lon,lat — lat is always 16–33, lon 34–56.
    if (Math.abs(lat) > 90 || (lat > 34 && lat < 56 && lon > 15 && lon < 33)) [lat, lon] = [lon, lat];
    return valid(lon, lat);
  }
  return null;
}
const valid = (lon, lat) => (isFinite(lon) && isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lon, lat] : null);
