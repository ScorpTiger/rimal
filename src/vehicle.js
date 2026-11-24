// Position marker: the owner's white Land Cruiser (top-down, front pointing up), or the classic arrow.
export const CRUISER_SVG = `
<svg viewBox="-40 -60 80 120" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="halo" r="0.5"><stop offset="0.55" stop-color="rgba(47,155,255,0.35)"/><stop offset="1" stop-color="rgba(47,155,255,0)"/></radialGradient>
    <linearGradient id="paint" x1="0" x2="1"><stop offset="0" stop-color="#d9dbdc"/><stop offset="0.18" stop-color="#ffffff"/><stop offset="0.82" stop-color="#ffffff"/><stop offset="1" stop-color="#cfd2d4"/></linearGradient>
    <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b4a55"/><stop offset="1" stop-color="#151d24"/></linearGradient>
  </defs>
  <circle r="56" fill="url(#halo)"/>
  <!-- heading cue -->
  <path d="M0 -58 L9 -46 L-9 -46 Z" fill="#2f9bff" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
  <!-- tyres -->
  <rect x="-21" y="-31" width="7" height="15" rx="2.5" fill="#1a1a1a"/><rect x="14" y="-31" width="7" height="15" rx="2.5" fill="#1a1a1a"/>
  <rect x="-21" y="17" width="7" height="15" rx="2.5" fill="#1a1a1a"/><rect x="14" y="17" width="7" height="15" rx="2.5" fill="#1a1a1a"/>
  <!-- body -->
  <rect x="-18.5" y="-42" width="37" height="84" rx="8" fill="url(#paint)" stroke="#6b7177" stroke-width="1.2"/>
  <!-- bonnet line + grille hint -->
  <path d="M-14 -40 Q0 -43 14 -40" fill="none" stroke="#9aa0a5" stroke-width="1"/>
  <rect x="-9" y="-42.5" width="18" height="2.2" rx="1" fill="#55595d"/>
  <!-- headlights -->
  <rect x="-17" y="-41.5" width="7" height="3.2" rx="1.4" fill="#fff6c8" stroke="#8b8f93" stroke-width="0.6"/>
  <rect x="10" y="-41.5" width="7" height="3.2" rx="1.4" fill="#fff6c8" stroke="#8b8f93" stroke-width="0.6"/>
  <!-- mirrors -->
  <rect x="-23" y="-17" width="5" height="3.5" rx="1.5" fill="#e8e9ea" stroke="#6b7177" stroke-width="0.8"/>
  <rect x="18" y="-17" width="5" height="3.5" rx="1.5" fill="#e8e9ea" stroke="#6b7177" stroke-width="0.8"/>
  <!-- windscreen -->
  <path d="M-15 -15 Q0 -19 15 -15 L13 -6 Q0 -8 -13 -6 Z" fill="url(#glass)"/>
  <!-- side glass -->
  <path d="M-16.5 -4 L-14.5 -4 L-14.5 25 L-16.5 26 Z" fill="#243039"/><path d="M16.5 -4 L14.5 -4 L14.5 25 L16.5 26 Z" fill="#243039"/>
  <!-- roof -->
  <rect x="-13" y="-5.5" width="26" height="32" rx="3" fill="#f7f7f6" stroke="#b9bdc0" stroke-width="0.8"/>
  <!-- roof rails -->
  <rect x="-12" y="-4" width="2" height="29" rx="1" fill="#a8adb1"/><rect x="10" y="-4" width="2" height="29" rx="1" fill="#a8adb1"/>
  <!-- rear window -->
  <path d="M-13 28 Q0 30 13 28 L14 35 Q0 37 -14 35 Z" fill="url(#glass)"/>
  <!-- tail lights -->
  <rect x="-17.5" y="37" width="5" height="4" rx="1.2" fill="#d6272e"/><rect x="12.5" y="37" width="5" height="4" rx="1.2" fill="#d6272e"/>
  <!-- spare wheel cover hint -->
  <rect x="-4" y="40" width="8" height="2" rx="1" fill="#7d8287"/>
</svg>`;

export const ARROW_SVG = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" fill="rgba(47,155,255,.22)"/><path d="M50 8 L80 84 L50 66 L20 84 Z" fill="#2f9bff" stroke="#fff" stroke-width="6" stroke-linejoin="round"/></svg>';
