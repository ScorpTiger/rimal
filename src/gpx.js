// GPX 1.1 import / export.
const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

export function parseGPX(text, fileName = 'import') {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Not a valid GPX file');
  const num = (el, tag) => { const n = el.getElementsByTagName(tag)[0]; return n ? parseFloat(n.textContent) : null; };
  const txt = (el, tag) => { const n = el.getElementsByTagName(tag)[0]; return n ? n.textContent.trim() : ''; };
  const pt = (el) => {
    const t = txt(el, 'time');
    return [parseFloat(el.getAttribute('lon')), parseFloat(el.getAttribute('lat')), num(el, 'ele'), t ? Date.parse(t) : null];
  };

  const waypoints = [...doc.getElementsByTagName('wpt')].map((w) => {
    const [lon, lat, ele] = pt(w);
    return { lon, lat, ele, name: txt(w, 'name') || 'Waypoint', notes: txt(w, 'desc') || txt(w, 'cmt'), icon: 'pin' };
  });

  const tracks = [];
  for (const trk of doc.getElementsByTagName('trk')) {
    const coords = [];
    for (const seg of trk.getElementsByTagName('trkseg')) for (const p of seg.getElementsByTagName('trkpt')) coords.push(pt(p));
    if (coords.length > 1) tracks.push({ name: txt(trk, 'name') || fileName, coords, source: 'gpx' });
  }
  for (const rte of doc.getElementsByTagName('rte')) {
    const coords = [...rte.getElementsByTagName('rtept')].map(pt);
    if (coords.length > 1) tracks.push({ name: txt(rte, 'name') || fileName, coords, source: 'gpx-route' });
  }
  return { waypoints, tracks };
}

export function toGPX({ tracks = [], waypoints = [] }, name = 'Rimal export') {
  const iso = (t) => (t ? `<time>${new Date(t).toISOString()}</time>` : '');
  const ele = (e) => (e != null && isFinite(e) ? `<ele>${e.toFixed(1)}</ele>` : '');
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Rimal Off-Road Navigator" xmlns="http://www.topografix.com/GPX/1/1">\n<metadata><name>${esc(name)}</name><time>${new Date().toISOString()}</time></metadata>\n`;
  for (const w of waypoints) {
    out += `<wpt lat="${w.lat.toFixed(7)}" lon="${w.lon.toFixed(7)}">${ele(w.ele)}${iso(w.created)}<name>${esc(w.name)}</name>${w.notes ? `<desc>${esc(w.notes)}</desc>` : ''}</wpt>\n`;
  }
  for (const t of tracks) {
    out += `<trk><name>${esc(t.name)}</name><trkseg>\n`;
    for (const p of t.coords) out += `<trkpt lat="${p[1].toFixed(7)}" lon="${p[0].toFixed(7)}">${ele(p[2])}${iso(p[3])}</trkpt>\n`;
    out += `</trkseg></trk>\n`;
  }
  return out + '</gpx>\n';
}
