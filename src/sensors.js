// Vehicle attitude (pitch / roll) and compass from the device's motion sensors.
// Many head units have an accelerometer; some don't — then `available` stays false.
export class Attitude {
  constructor(onChange) {
    this.onChange = onChange;
    this.available = false;
    this.pitch = null; this.roll = null; this.compass = null;
    this.cal = { pitch: 0, roll: 0 };
    this._raw = { pitch: 0, roll: 0 };
  }
  start() {
    const handler = (e) => {
      if (e.beta == null && e.gamma == null) return;
      this.available = true;
      // Smooth: vehicles bounce; a light low-pass keeps the gauge readable.
      const k = 0.25;
      this._raw.pitch += k * ((e.beta ?? 0) - this._raw.pitch);
      this._raw.roll += k * ((e.gamma ?? 0) - this._raw.roll);
      this.pitch = this._raw.pitch - this.cal.pitch;
      this.roll = this._raw.roll - this.cal.roll;
      if (e.absolute && e.alpha != null) this.compass = (360 - e.alpha) % 360;
      this.onChange?.(this);
    };
    window.addEventListener('deviceorientationabsolute', handler);
    window.addEventListener('deviceorientation', handler);
    // Fallback: compute from gravity if orientation events are missing but motion is present.
    window.addEventListener('devicemotion', (e) => {
      if (this.available) return;
      const g = e.accelerationIncludingGravity; if (!g || g.x == null) return;
      const pitch = (Math.atan2(g.y, Math.hypot(g.x, g.z)) * 180) / Math.PI;
      const roll = (Math.atan2(-g.x, g.z) * 180) / Math.PI;
      handler({ beta: pitch, gamma: roll });
    });
  }
  /** Park on level ground and call this: the current mount angle becomes zero. */
  calibrate() { this.cal = { pitch: this._raw.pitch, roll: this._raw.roll }; return this.cal; }
}

/** Draws a simple 4x4 silhouette tilted by the angle. view: 'side' (pitch) | 'rear' (roll) */
export function gaugeSVG(angle, view, warn) {
  const a = angle == null ? 0 : Math.max(-60, Math.min(60, angle));
  const bad = angle != null && Math.abs(angle) >= warn;
  const col = angle == null ? '#666' : bad ? '#e5484d' : Math.abs(angle) >= warn * 0.7 ? '#e8a33d' : '#46a758';
  const body = view === 'side'
    ? '<rect x="-34" y="-14" width="68" height="18" rx="4"/><path d="M-22 -14 L-14 -28 H16 L24 -14Z"/><circle cx="-20" cy="8" r="8"/><circle cx="20" cy="8" r="8"/>'
    : '<rect x="-26" y="-16" width="52" height="22" rx="5"/><path d="M-18 -16 L-14 -30 H14 L18 -16Z"/><rect x="-30" y="4" width="10" height="14" rx="3"/><rect x="20" y="4" width="10" height="14" rx="3"/>';
  return `<svg viewBox="-50 -45 100 80"><line x1="-48" y1="18" x2="48" y2="18" stroke="#555" stroke-width="1.5" stroke-dasharray="3 3"/>
    <g transform="rotate(${view === 'side' ? -a : a})" fill="${col}">${body}</g>
    <text x="0" y="33" text-anchor="middle" font-size="13" font-weight="800" fill="currentColor">${angle == null ? '—' : Math.round(Math.abs(angle)) + '°'}</text></svg>`;
}
