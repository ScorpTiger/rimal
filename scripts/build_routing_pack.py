#!/usr/bin/env python3
"""
Build Rimal's offline road-routing pack ("Road directions") from an OpenStreetMap .osm.pbf extract.

    python3 scripts/build_routing_pack.py gcc-states-latest.osm.pbf ksa-routing-YYYYMMDD.rrt [--bbox 34.4,16.3,55.8,32.2]

Output format "RIMALRT1" — a single file the app reads with random access (no need to load it all):
  b'RIMALRT1' | u32 index_len | gzip(JSON index) | cell blobs (each gzip'd)
  index = { v, cell (degrees), bbox, nx, ny, cells: { cid: [offset, length] }, names... }
  A cell (0.25° square) holds the junction nodes inside it and every directed road edge leaving them:
    u32 nNodes, u32 nEdges, u32 nCoords, u32 namesBytes
    Int32 lon[n], Int32 lat[n]              (1e-6 degrees)
    Uint32 edgeStart[n+1]                    (CSR: edges of node i are edgeStart[i]..edgeStart[i+1])
    Uint32 toNode[e] (cid << 20 | local)     Uint32 lenDm[e] (decimetres)
    Uint32 geomStart[e+1] (into coords)      Int32 coords[2 * nCoords] (shape points between the two nodes)
    Uint16 name[e] (0xFFFF = none)           Uint8 cls[e]   Uint8 flags[e] (1 roundabout, 2 track, 4 link)
    UTF-8 JSON array of street names
"""
import argparse, gzip, json, math, struct, sys, time
from array import array
import numpy as np
import osmium

CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
           'living_street', 'service', 'track', 'motorway_link', 'trunk_link', 'primary_link',
           'secondary_link', 'tertiary_link', 'road']
SPEED = {'motorway': 110, 'trunk': 100, 'primary': 80, 'secondary': 70, 'tertiary': 60, 'unclassified': 50,
         'residential': 35, 'living_street': 15, 'service': 20, 'track': 25, 'motorway_link': 60,
         'trunk_link': 55, 'primary_link': 50, 'secondary_link': 45, 'tertiary_link': 40, 'road': 40}
CLS = {c: i for i, c in enumerate(CLASSES)}
CELL = 0.25
NO_ACCESS = {'no', 'private'}
SKIP_SERVICE = {'parking_aisle', 'driveway', 'drive-through'}


class Ways(osmium.SimpleHandler):
    def __init__(self, bbox):
        super().__init__()
        self.bbox = bbox
        self.ids = array('q'); self.lon = array('i'); self.lat = array('i')
        self.wstart = array('q', [0]); self.wcls = array('B'); self.wflags = array('B'); self.wdir = array('b'); self.wname = []
        self.n = 0

    def way(self, w):
        t = w.tags
        hw = t.get('highway')
        if hw not in CLS: return
        if t.get('access') in NO_ACCESS or t.get('motor_vehicle') in NO_ACCESS or t.get('motorcar') in NO_ACCESS: return
        if hw == 'service' and t.get('service') in SKIP_SERVICE: return
        if t.get('area') == 'yes': return
        try:
            pts = [(n.ref, n.location.lon, n.location.lat) for n in w.nodes if n.location.valid()]
        except osmium.InvalidLocationError:
            return
        if len(pts) < 2: return
        b = self.bbox
        if not any(b[0] <= x <= b[2] and b[1] <= y <= b[3] for _, x, y in pts): return
        ow = t.get('oneway', '')
        rb = t.get('junction') in ('roundabout', 'circular')
        if ow in ('-1', 'reverse'): d = -1
        elif ow in ('yes', 'true', '1') or (rb and ow != 'no') or (hw in ('motorway', 'motorway_link') and ow != 'no'): d = 1
        else: d = 0
        for ref, x, y in pts:
            self.ids.append(ref); self.lon.append(round(x * 1e6)); self.lat.append(round(y * 1e6))
        self.wstart.append(len(self.ids))
        self.wcls.append(CLS[hw])
        self.wflags.append((1 if rb else 0) | (2 if hw == 'track' else 0) | (4 if hw.endswith('_link') else 0))
        self.wdir.append(d)
        self.wname.append(t.get('name:en') or t.get('name') or t.get('ref') or '')
        self.n += 1
        if self.n % 200000 == 0: print(f'  {self.n:,} ways', flush=True)


def hav(lon1, lat1, lon2, lat2):
    p = math.pi / 180
    a = 0.5 - math.cos((lat2 - lat1) * p) / 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * (1 - math.cos((lon2 - lon1) * p)) / 2
    return 12742000 * math.asin(math.sqrt(min(1, a)))


def simplify(pts, tol_m=2.5):
    """Douglas–Peucker on (lon, lat) in 1e-6 deg; keeps the ends."""
    if len(pts) <= 2: return pts
    lat0 = pts[0][1] * 1e-6
    kx = 0.111320 * math.cos(lat0 * math.pi / 180); ky = 0.110540  # metres per 1e-6 deg
    keep = [False] * len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        ax, ay = pts[i][0] * kx, pts[i][1] * ky; bx, by = pts[j][0] * kx, pts[j][1] * ky
        dx, dy = bx - ax, by - ay; L = dx * dx + dy * dy
        best, bi = 0, -1
        for k in range(i + 1, j):
            px, py = pts[k][0] * kx, pts[k][1] * ky
            if L == 0: d = math.hypot(px - ax, py - ay)
            else:
                u = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L))
                d = math.hypot(px - (ax + u * dx), py - (ay + u * dy))
            if d > best: best, bi = d, k
        if best > tol_m:
            keep[bi] = True; stack.append((i, bi)); stack.append((bi, j))
    return [p for p, k in zip(pts, keep) if k]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pbf'); ap.add_argument('out')
    ap.add_argument('--bbox', default='34.4,16.3,55.8,32.2')
    a = ap.parse_args()
    bbox = [float(v) for v in a.bbox.split(',')]
    t0 = time.time()
    print('Reading roads…', flush=True)
    h = Ways(bbox)
    h.apply_file(a.pbf, locations=True, idx='flex_mem')
    ids = np.frombuffer(h.ids, dtype=np.int64); lon = np.frombuffer(h.lon, dtype=np.int32); lat = np.frombuffer(h.lat, dtype=np.int32)
    ws = np.frombuffer(h.wstart, dtype=np.int64)
    print(f'{h.n:,} roads, {len(ids):,} road points ({time.time() - t0:.0f} s)', flush=True)

    # Junctions: points used more than once, plus the ends of every road.
    uniq, counts = np.unique(ids, return_counts=True)
    is_j = np.zeros(len(ids), dtype=bool)
    pos = np.searchsorted(uniq, ids)
    is_j |= counts[pos] > 1
    is_j[ws[:-1]] = True; is_j[ws[1:] - 1] = True
    print(f'{int(np.count_nonzero(counts > 1)):,} shared points', flush=True)

    # Number the junction nodes per cell.
    nx = math.ceil((bbox[2] - bbox[0]) / CELL); ny = math.ceil((bbox[3] - bbox[1]) / CELL)
    def cid_of(x, y):
        cx = min(nx - 1, max(0, int((x * 1e-6 - bbox[0]) / CELL))); cy = min(ny - 1, max(0, int((y * 1e-6 - bbox[1]) / CELL)))
        return cy * nx + cx
    node_key = {}            # osm id → (cid << 20) | local
    cells = {}               # cid → {'lon': [], 'lat': [], 'out': [[edges]...]}
    def node(i):
        osm = int(ids[i]); k = node_key.get(osm)
        if k is None:
            c = cid_of(int(lon[i]), int(lat[i]))
            cell = cells.setdefault(c, {'lon': [], 'lat': [], 'out': []})
            loc = len(cell['lon'])
            if loc >= (1 << 20): raise SystemExit('cell too dense')
            cell['lon'].append(int(lon[i])); cell['lat'].append(int(lat[i])); cell['out'].append([])
            k = (c << 20) | loc; node_key[osm] = k
        return k
    names = {}
    def name_id(s):
        if not s: return 0xFFFF
        return names.setdefault(s, len(names)) if len(names) < 0xFFFE else 0xFFFF
    n_edges = 0
    for w in range(h.n):
        s, e = int(ws[w]), int(ws[w + 1])
        cls, fl, d, nm = h.wcls[w], h.wflags[w], h.wdir[w], name_id(h.wname[w])
        j = [i for i in range(s, e) if is_j[i]]
        for a_i, b_i in zip(j, j[1:]):
            pts = [(int(lon[i]), int(lat[i])) for i in range(a_i, b_i + 1)]
            length = sum(hav(pts[k][0] * 1e-6, pts[k][1] * 1e-6, pts[k + 1][0] * 1e-6, pts[k + 1][1] * 1e-6) for k in range(len(pts) - 1))
            if length <= 0: continue
            geo = simplify(pts)[1:-1]
            ka, kb = node(a_i), node(b_i)
            if d >= 0: cells[ka >> 20]['out'][ka & 0xFFFFF].append((kb, length, geo, nm, cls, fl)); n_edges += 1
            if d <= 0: cells[kb >> 20]['out'][kb & 0xFFFFF].append((ka, length, geo[::-1], nm, cls, fl)); n_edges += 1
        if w % 200000 == 0 and w: print(f'  edges for {w:,} roads…', flush=True)
    print(f'{len(node_key):,} junctions, {n_edges:,} directed edges in {len(cells):,} cells ({time.time() - t0:.0f} s)', flush=True)

    # Street names: one table per file (index), referenced from edges.
    name_list = [None] * len(names)
    for s_, i in names.items(): name_list[i] = s_

    blobs, index = [], {}
    off = 0
    for c in sorted(cells):
        cell = cells[c]; n = len(cell['lon'])
        estart = array('I', [0]); to = array('I'); ln = array('I'); gstart = array('I', [0]); coords = array('i')
        nm = array('H'); cl = array('B'); fg = array('B')
        for outs in cell['out']:
            for (k, length, geo, nid, cls, fl) in outs:
                to.append(k); ln.append(min(0xFFFFFFFF, round(length * 10))); nm.append(nid); cl.append(cls); fg.append(fl)
                for x, y in geo: coords.append(x); coords.append(y)
                gstart.append(len(coords) // 2)
            estart.append(len(to))
        parts = [struct.pack('<4I', n, len(to), len(coords) // 2, 0),
                 array('i', cell['lon']).tobytes(), array('i', cell['lat']).tobytes(), estart.tobytes(), to.tobytes(), ln.tobytes(),
                 gstart.tobytes(), coords.tobytes(), nm.tobytes(), cl.tobytes(), fg.tobytes()]
        blob = gzip.compress(b''.join(parts), 6)
        index[str(c)] = [off, len(blob)]; blobs.append(blob); off += len(blob)
    head = gzip.compress(json.dumps({'v': 1, 'cell': CELL, 'bbox': bbox, 'nx': nx, 'ny': ny, 'cells': index, 'names': name_list,
                                     'classes': CLASSES, 'speeds': SPEED, 'created': time.strftime('%Y-%m-%d'),
                                     'source': 'OpenStreetMap contributors (ODbL)'}, ensure_ascii=False, separators=(',', ':')).encode())
    with open(a.out, 'wb') as f:
        f.write(b'RIMALRT1'); f.write(struct.pack('<I', len(head))); f.write(head)
        for b in blobs: f.write(b)
    print(f'Wrote {a.out}: {(12 + len(head) + off) / 1e6:.1f} MB (index {len(head) / 1e6:.1f} MB) in {time.time() - t0:.0f} s', flush=True)


if __name__ == '__main__':
    main()
