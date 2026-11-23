// Vehicle attitude (pitch / roll) from the head unit's accelerometer, for ANY mounting angle.
//
// Head units are mounted upright (or tilted) in the dashboard, in landscape — so the raw phone-style
// beta/gamma angles are meaningless for the vehicle. Instead we measure the gravity direction in the
// device frame and compare it with a "level" reference captured when the car stands level:
//   U = reference up vector (car level)        L = screen-right direction, made horizontal (car's lateral axis)
//   F = U × L (car's forward axis, pointing away from the driver)
//   pitch = asin(-u·F)  (nose up positive)      roll = asin(u·L)  (right side down positive)
const norm = (v) => { const m = Math.hypot(...v) || 1; return v.map((x) => x / m); };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const deg = (r) => (r * 180) / Math.PI;

function screenRight() {
  // Screen "right" in device coordinates for the current display rotation.
  const a = (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0;
  switch (((a % 360) + 360) % 360) {
    case 90: return [0, 1, 0];
    case 180: return [-1, 0, 0];
    case 270: return [0, -1, 0];
    default: return [1, 0, 0];
  }
}

export class Attitude {
  constructor(onChange) {
    this.onChange = onChange;
    this.available = false;
    this.pitch = null; this.roll = null; this.compass = null;
    this.cal = null;       // { up: [x,y,z], right: [x,y,z], auto: bool }
    this.up = null;        // smoothed current up vector (device frame)
    this.samples = 0;
  }

  _update(upRaw) {
    const u = norm(upRaw);
    if (!u.every(Number.isFinite)) return;
    const k = 0.2; // low-pass: vehicles bounce
    this.up = this.up ? norm(this.up.map((x, i) => x + k * (u[i] - x))) : u;
    this.available = true;
    this.samples++;
    // No saved level reference yet: assume the car is level ~2 s after start (user can recalibrate).
    if (!this.cal && this.samples > 20) this.cal = { up: [...this.up], right: screenRight(), auto: true };
    if (!this.cal) return;
    const U = norm(this.cal.up);
    let L = this.cal.right; L = norm(L.map((x, i) => x - dot(L, U) * U[i]));
    let F = norm(cross(U, L));
    if (F[2] > 0) F = F.map((x) => -x); // forward = away from the driver = behind the screen
    const clamp = (x) => Math.max(-1, Math.min(1, x));
    this.pitch = deg(Math.asin(clamp(-dot(this.up, F))));
    this.roll = deg(Math.asin(clamp(dot(this.up, L))));
    this.onChange?.(this);
  }

  start() {
    let motion = false;
    // accelerationIncludingGravity at rest points UP (it measures the support force).
    window.addEventListener('devicemotion', (e) => {
      const g = e.accelerationIncludingGravity;
      if (!g || g.x == null) return;
      motion = true;
      this._update([g.x, g.y, g.z]);
    });
    const orient = (e) => {
      if (e.absolute && e.alpha != null) this.compass = (360 - e.alpha) % 360;
      if (motion || e.beta == null || e.gamma == null) return;
      // Fallback: up vector from orientation angles (W3C device frame).
      const b = (e.beta * Math.PI) / 180, g = (e.gamma * Math.PI) / 180;
      this._update([-Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g)]);
    };
    window.addEventListener('deviceorientationabsolute', orient);
    window.addEventListener('deviceorientation', orient);
  }

  /** Park on level ground and call this: the current mounting becomes 0° / 0°. */
  calibrate() {
    if (!this.up) return this.cal;
    this.cal = { up: [...this.up], right: screenRight(), auto: false };
    this._update(this.up);
    return this.cal;
  }
  setCalibration(c) { this.cal = c && Array.isArray(c.up) ? c : null; }
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
