// Pure logic for the fuel log, trip-prep checklist and archive imports (no UI here).
import { unzipSync, strFromU8 } from 'fflate';

/* ---------- Fuel log ---------- */
// Entry: { id, t, odo (km), litres, price (total SAR), full (bool), note, lon, lat }
// Consumption is measured between two FULL fill-ups: litres added after the first, over distance driven.
export function fuelStats(entries) {
  const e = [...entries].sort((a, b) => a.odo - b.odo || a.t - b.t);
  const legs = [];
  let lastFull = null, litresSince = 0;
  for (const x of e) {
    if (lastFull) litresSince += +x.litres || 0;
    if (x.full) {
      if (lastFull && x.odo > lastFull.odo) legs.push({ from: lastFull, to: x, km: x.odo - lastFull.odo, litres: litresSince, l100: (litresSince / (x.odo - lastFull.odo)) * 100 });
      lastFull = x; litresSince = 0;
    }
  }
  const litres = e.reduce((s, x) => s + (+x.litres || 0), 0);
  const spend = e.reduce((s, x) => s + (+x.price || 0), 0);
  const kmLegs = legs.reduce((s, l) => s + l.km, 0), litLegs = legs.reduce((s, l) => s + l.litres, 0);
  const avg = kmLegs ? (litLegs / kmLegs) * 100 : null;
  const span = e.length > 1 ? e[e.length - 1].odo - e[0].odo : 0;
  return {
    count: e.length, litres, spend, legs, avgL100: avg, lastL100: legs.length ? legs[legs.length - 1].l100 : null,
    costPerKm: span > 0 && spend ? spend / span : null, pricePerLitre: litres ? spend / litres : null,
  };
}
// Range estimate from measured consumption and tank size (litres).
export const rangeFrom = (tankL, l100) => (tankL && l100 ? Math.round((tankL / l100) * 100) : null);

/* ---------- Trip-prep checklist ---------- */
export const DEFAULT_CHECKLIST = [
  ['Vehicle', ['Tyre pressure gauge + deflator', 'Air compressor (tested)', 'Spare tyre inflated + jack + wheel spanner', 'Engine oil, coolant, brake fluid checked', 'Fuel full + jerry can', 'Battery terminals tight / jump leads']],
  ['Recovery', ['Recovery boards (traction mats)', 'Shovel', 'Kinetic / snatch rope + soft shackles', 'Gloves', 'Tyre repair (plug) kit', 'Recovery points fitted front & rear']],
  ['Water & food', ['Drinking water — 5 L per person per day + 1 spare day', 'Extra water for the radiator', 'Food + snacks', 'Cool box / ice']],
  ['Safety & comms', ['First-aid kit', 'Fire extinguisher', 'Told someone the route & return time', 'Satellite messenger / phone fully charged', 'Power bank + car chargers', 'Head torch + spare batteries', 'Sun protection: hat, sunscreen, sunglasses', 'Warm layers for the night']],
  ['Navigation (Rimal)', ['Offline maps installed for the area', 'Route / waypoints loaded', 'Weather saved before leaving signal', 'GPS shows a fix (green)']],
  ['Camping', ['Tent / swag + sleeping bags', 'Stove + gas', 'Firewood', 'Rubbish bags (leave no trace)']],
];
export function defaultChecklist() {
  return DEFAULT_CHECKLIST.flatMap(([group, items]) => items.map((text, i) => ({ id: `${group}-${i}`, group, text, done: false })));
}

/* ---------- Archives (Gaia GPS folder exports, KMZ) ---------- */
// Returns [{ name, text }] for every track/waypoint file inside a .zip or .kmz.
export function filesFromZip(buf) {
  const out = [];
  const files = unzipSync(new Uint8Array(buf));
  for (const [path, data] of Object.entries(files)) {
    if (path.endsWith('/') || path.startsWith('__MACOSX') || path.split('/').pop().startsWith('.')) continue;
    if (/\.(gpx|kml|geojson|json)$/i.test(path)) out.push({ name: path.split('/').pop(), text: strFromU8(data) });
    else if (/\.(zip|kmz)$/i.test(path)) out.push(...filesFromZip(data));
  }
  return out;
}
