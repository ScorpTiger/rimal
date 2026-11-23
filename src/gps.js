// GPS source: real Geolocation API, or a demo simulator driving through the desert near Riyadh.
import { bearing, distance, destination } from './geo.js';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';

// iOS WKWebView geolocation is unreliable/asks repeatedly; use the native plugin there.
// Android keeps the WebView path that is already device-tested.
const useNative = Capacitor.getPlatform() === 'ios';

export class GPS {
  constructor(onFix, onError) {
    this.onFix = onFix;
    this.onError = onError;
    this.watchId = null;
    this.sim = null;
    this.last = null;
    this.lastCourse = null;
  }

  start(demo = false) {
    this.stop();
    if (demo) return this.startSim();
    if (useNative) return this.startNative();
    if (!('geolocation' in navigator)) { this.onError?.('This device has no location service'); return; }
    this.watchId = navigator.geolocation.watchPosition(
      (p) => this.emit({
        lon: p.coords.longitude, lat: p.coords.latitude, alt: p.coords.altitude,
        acc: p.coords.accuracy, speed: p.coords.speed, heading: p.coords.heading, t: p.timestamp || Date.now(),
      }),
      (e) => this.onError?.(e.code === 1 ? 'Location permission denied' : e.code === 3 ? 'Waiting for GPS…' : 'GPS unavailable'),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
  }

  async startNative() {
    try {
      const perm = await Geolocation.checkPermissions().catch(() => null);
      if (!perm || perm.location !== 'granted') await Geolocation.requestPermissions().catch(() => {});
      this.nativeId = await Geolocation.watchPosition({ enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }, (p, err) => {
        if (err || !p) return this.onError?.(String(err?.message || err || '').toLowerCase().includes('denied') ? 'Location permission denied' : 'Waiting for GPS…');
        this.emit({ lon: p.coords.longitude, lat: p.coords.latitude, alt: p.coords.altitude, acc: p.coords.accuracy, speed: p.coords.speed, heading: p.coords.heading, t: p.timestamp || Date.now() });
      });
    } catch (e) { this.onError?.(String(e?.message || e).toLowerCase().includes('denied') ? 'Location permission denied' : 'GPS unavailable'); }
  }

  stop() {
    if (this.nativeId) { Geolocation.clearWatch({ id: this.nativeId }).catch(() => {}); this.nativeId = null; }
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    clearInterval(this.sim);
    this.sim = null;
  }

  emit(fix) {
    // Fill missing speed / course from consecutive fixes (many head-unit GPS chips omit them).
    if (this.last) {
      const dt = (fix.t - this.last.t) / 1000;
      const d = distance([this.last.lon, this.last.lat], [fix.lon, fix.lat]);
      if ((fix.speed == null || isNaN(fix.speed)) && dt > 0) fix.speed = d / dt;
      if ((fix.heading == null || isNaN(fix.heading)) && d > 3) fix.heading = bearing([this.last.lon, this.last.lat], [fix.lon, fix.lat]);
    }
    // When crawling or stopped, GPS course is noise — hold the previous one.
    if (fix.speed != null && fix.speed < 1.2 && this.lastCourse != null) fix.heading = this.lastCourse;
    if (fix.heading != null && !isNaN(fix.heading)) this.lastCourse = fix.heading;
    else fix.heading = this.lastCourse;
    this.last = fix;
    this.onFix(fix);
  }

  startSim() {
    // A loop of dune-bashing legs east of Riyadh (Red Sands / Al Thumamah area).
    let pos = this.last ? [this.last.lon, this.last.lat] : [46.86, 24.58];
    let course = 75, alt = 640, t = Date.now(), step = 0;
    const tick = () => {
      step++;
      course += Math.sin(step / 9) * 6 + (step % 120 === 0 ? 120 : 0);
      const speed = 11 + Math.sin(step / 13) * 5; // ~25–60 km/h
      pos = destination(pos, course, speed);
      alt += Math.sin(step / 7) * 1.5;
      t += 1000;
      this.emit({ lon: pos[0], lat: pos[1], alt, acc: 4, speed, heading: (course + 360) % 360, t });
    };
    tick();
    this.sim = setInterval(tick, 1000);
  }
}
