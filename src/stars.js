// Stargazing planner: tonight's real darkness window, the Moon, and when the Milky Way core is up.
import * as SunCalc from 'suncalc';

const RAD = Math.PI / 180;
// Galactic centre (Sagittarius A*), J2000.
const GC = { ra: 266.417 * RAD, dec: -29.008 * RAD };

function lst(date, lon) { // local sidereal time, radians
  const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  return ((280.46061837 + 360.98564736629 * d + lon) % 360) * RAD;
}
export function altitudeOf(ra, dec, date, lon, lat) {
  const H = lst(date, lon) - ra, φ = lat * RAD;
  return Math.asin(Math.sin(φ) * Math.sin(dec) + Math.cos(φ) * Math.cos(dec) * Math.cos(H)) / RAD;
}

const PHASES = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
export function moonPhaseName(phase) { return PHASES[Math.round(phase * 8) % 8]; }
export function moonGlyph(phase) { return ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'][Math.round(phase * 8) % 8]; }

// Plan the coming night at a position. Scans in 10-minute steps from sunset to next sunrise.
export function planNight(lon, lat, now = new Date()) {
  let base = new Date(now);
  let t = SunCalc.getTimes(base, lat, lon);
  // After this morning's sunrise but before sunset → tonight. After midnight but before sunrise → the current night.
  if (now < t.sunrise) { base = new Date(now.getTime() - 86400000); t = SunCalc.getTimes(base, lat, lon); }
  const next = SunCalc.getTimes(new Date(base.getTime() + 86400000), lat, lon);
  const darkStart = t.night, darkEnd = next.nightEnd; // astronomical twilight ends / begins (sun 18° below)
  const step = 10 * 60000;
  let moonFreeMin = 0, best = null, cur = null, coreUp = null, coreBestAlt = -90, coreBestAt = null;
  const samples = [];
  if (!isNaN(darkStart) && !isNaN(darkEnd)) {
    for (let ms = darkStart.getTime(); ms <= darkEnd.getTime(); ms += step) {
      const d = new Date(ms);
      const m = SunCalc.getMoonPosition(d, lat, lon);
      const moonUp = m.altitude > -0.833 * RAD;
      const core = altitudeOf(GC.ra, GC.dec, d, lon, lat);
      samples.push({ t: ms, moonAlt: m.altitude / RAD, core });
      if (!moonUp) {
        moonFreeMin += 10;
        if (!cur) cur = { from: ms, to: ms }; else cur.to = ms;
        if (!best || cur.to - cur.from > best.to - best.from) best = { ...cur };
      } else cur = null;
      if (core > 10 && !moonUp) { if (!coreUp) coreUp = { from: ms, to: ms }; else coreUp.to = ms; }
      if (!moonUp && core > coreBestAlt) { coreBestAlt = core; coreBestAt = ms; }
    }
  }
  const mid = !isNaN(darkStart) ? new Date((darkStart.getTime() + (darkEnd?.getTime() || darkStart.getTime())) / 2) : now;
  const ill = SunCalc.getMoonIllumination(mid);
  const mt = SunCalc.getMoonTimes(base, lat, lon), mt2 = SunCalc.getMoonTimes(new Date(base.getTime() + 86400000), lat, lon);
  const pick = (a, b) => [a, b].filter((x) => x && x > t.sunset - 3 * 3600e3 && x < next.sunrise)[0] || null;
  // Score 0-10: darkness hours without the Moon, then Moon brightness penalty.
  const darkHrs = !isNaN(darkStart) ? (darkEnd - darkStart) / 3600e3 : 0;
  const score = Math.max(0, Math.min(10, Math.round((moonFreeMin / 60 / Math.max(darkHrs, 1)) * 10 - (moonFreeMin === 0 ? ill.fraction * 3 : 0))));
  return {
    sunset: t.sunset, darkStart, darkEnd, sunrise: next.sunrise, darkHours: darkHrs,
    moon: { fraction: ill.fraction, phase: ill.phase, name: moonPhaseName(ill.phase), glyph: moonGlyph(ill.phase), rise: pick(mt.rise, mt2.rise), set: pick(mt.set, mt2.set) },
    moonFreeHours: moonFreeMin / 60, bestWindow: best, milkyWay: coreUp ? { ...coreUp, maxAlt: Math.round(coreBestAlt) } : null, coreBestAt, score, samples,
  };
}

// Simple 0-10 rating for the next 7 nights (for picking a trip date).
export function nextNights(lon, lat, n = 7, from = new Date()) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(from.getTime() + i * 86400000); d.setHours(14, 0, 0, 0);
    const p = planNight(lon, lat, d);
    out.push({ date: d, score: p.score, moon: p.moon, moonFreeHours: p.moonFreeHours, milkyWay: !!p.milkyWay });
  }
  return out;
}
