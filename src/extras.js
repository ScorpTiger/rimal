// Sun times, weather (cached for offline), POI search, elevation profile chart.
import * as SunCalc from 'suncalc';
import { distance } from './geo.js';
import * as store from './storage.js';
import { netFetch, isOnline } from './tiles.js';

export function sunTimes(lon, lat, date = new Date()) {
  const t = SunCalc.getTimes(date, lat, lon);
  return { sunrise: t.sunrise, sunset: t.sunset, dusk: t.dusk, dawn: t.dawn };
}
export const hhmm = (d) => (d && !isNaN(d) ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—');

/* ---------- weather: Open-Meteo, last forecast kept for offline ---------- */
export async function weather(lon, lat, force = false) {
  const cached = await store.get('kv', 'weather');
  const fresh = cached && Date.now() - cached.at < 3 * 3600e3 && distance([lon, lat], cached.at_pos) < 30000;
  if (fresh && !force) return cached;
  if (!isOnline()) return cached || null;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&current=temperature_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m,weather_code,visibility&hourly=temperature_2m,wind_gusts_10m,precipitation_probability&daily=temperature_2m_max,temperature_2m_min,wind_gusts_10m_max,precipitation_sum&forecast_days=4&timezone=auto`;
    const bytes = await netFetch(url, null, 12000);
    const data = JSON.parse(new TextDecoder().decode(bytes));
    const out = { at: Date.now(), at_pos: [lon, lat], data };
    await store.put('kv', out, 'weather');
    return out;
  } catch (e) { console.warn('Weather fetch failed', e?.message || e); return cached || null; }
}
export const WX = { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Fog', 51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle', 61: 'Rain', 63: 'Rain', 65: 'Heavy rain', 80: 'Showers', 81: 'Showers', 82: 'Heavy showers', 95: 'Thunderstorm', 96: 'Thunderstorm + hail', 99: 'Thunderstorm + hail' };

/* ---------- POIs ---------- */
export const POI_CATS = {
  fuel: { label: 'Fuel', icon: '⛽', color: '#e5484d' },
  water: { label: 'Water / well', icon: '💧', color: '#2f9bff' },
  camp: { label: 'Camping', icon: '⛺', color: '#46a758' },
  repair: { label: 'Mechanic / tyres', icon: '🔧', color: '#e8a33d' },
  hospital: { label: 'Hospital / clinic', icon: '✚', color: '#ff3b8d' },
  police: { label: 'Police', icon: '🛡', color: '#5b8cff' },
  food: { label: 'Food / shop', icon: '🛒', color: '#c04cff' },
  mosque: { label: 'Mosque', icon: '🕌', color: '#18b37e' },
  place: { label: 'Towns & villages', icon: '🏘', color: '#a99d8c' },
  sight: { label: 'Sights & nature', icon: '⛰', color: '#00c2d6' },
};
let poiItems = []; // [lon, lat, cat, name, nameAr]
export function setPOIs(items) { poiItems = items || []; }
export const poiCount = () => poiItems.length;
export function nearest(pos, cat, n = 25) {
  const list = [];
  for (const p of poiItems) if (!cat || p[2] === cat) list.push([distance(pos, p), p]);
  list.sort((a, b) => a[0] - b[0]);
  return list.slice(0, n);
}
export function search(q, pos, n = 40) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const p of poiItems) {
    if ((p[3] && p[3].toLowerCase().includes(q)) || (p[4] && p[4].includes(q))) out.push([pos ? distance(pos, p) : 0, p]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.slice(0, n);
}
export const poiGeoJSON = () => ({ type: 'FeatureCollection', features: poiItems.filter((p) => p[2] !== 'place').map((p) => ({ type: 'Feature', properties: { cat: p[2], name: p[3] || p[4] || POI_CATS[p[2]]?.label, color: POI_CATS[p[2]]?.color || '#888' }, geometry: { type: 'Point', coordinates: [p[0], p[1]] } })) });

/* ---------- elevation profile ---------- */
export function profileSVG(coords, units = 'metric', w = 680, h = 160) {
  const pts = []; let d = 0;
  for (let i = 0; i < coords.length; i++) {
    if (i) d += distance(coords[i - 1], coords[i]);
    if (coords[i][2] != null && isFinite(coords[i][2])) pts.push([d, coords[i][2]]);
  }
  if (pts.length < 2) return '<p class="note">No elevation data in this track.</p>';
  const step = Math.max(1, Math.floor(pts.length / 400));
  const s = pts.filter((_, i) => i % step === 0);
  const minE = Math.min(...s.map((p) => p[1])), maxE = Math.max(...s.map((p) => p[1]));
  const span = Math.max(20, maxE - minE), total = d || 1;
  const X = (v) => 40 + (v / total) * (w - 50), Y = (e) => h - 22 - ((e - minE) / span) * (h - 40);
  const path = s.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
  const ft = units === 'imperial';
  const lab = (e) => `${Math.round(ft ? e * 3.28084 : e)}${ft ? ' ft' : ' m'}`;
  let climb = 0; for (let i = 1; i < s.length; i++) if (s[i][1] > s[i - 1][1]) climb += s[i][1] - s[i - 1][1];
  return `<svg viewBox="0 0 ${w} ${h}" class="profile"><path d="${path} L${X(total)},${h - 22} L40,${h - 22}Z" fill="rgba(232,163,61,.25)"/><path d="${path}" fill="none" stroke="#e8a33d" stroke-width="2.5"/>
    <text x="4" y="${Y(maxE) + 4}" font-size="11" fill="currentColor">${lab(maxE)}</text><text x="4" y="${h - 24}" font-size="11" fill="currentColor">${lab(minE)}</text>
    <text x="${w - 4}" y="${h - 6}" font-size="11" text-anchor="end" fill="currentColor">${(total / (ft ? 1609.344 : 1000)).toFixed(1)} ${ft ? 'mi' : 'km'} · climb ${lab(climb)}</text></svg>`;
}
