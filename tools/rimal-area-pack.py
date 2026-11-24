#!/usr/bin/env python3
"""
Rimal area pack builder — high-detail satellite imagery for a circle around a point,
packed into one .pmtiles file you copy to the car screen / phone by USB.

Runs on a Mac (or any computer) with only the Python that ships with macOS — nothing to install.

    python3 rimal-area-pack.py --center 26.6170,37.9170 --radius 50 --maxzoom 18

  * Resumable: stop it any time (Ctrl+C, lid closed, Wi-Fi drop) and run the same command again —
    it carries on where it stopped. Tiles already downloaded are never fetched twice.
  * Keep the Mac awake while it runs:   caffeinate -i python3 rimal-area-pack.py ...
  * When it finishes you get   ksa-satellite-<name>-<date>.pmtiles   next to this script.
    In Rimal: Maps → Import from USB / more → pick the file.

Imagery: Esri World Imagery (© Esri, Maxar, Earthstar Geographics). For personal use only —
do not share or publish the file.
"""
import argparse, datetime, gzip, hashlib, json, math, os, queue, sqlite3, ssl, struct, sys, threading, time
import urllib.request, urllib.error

URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
ATTRIBUTION = 'Imagery © Esri, Maxar, Earthstar Geographics'
DATA_START = 16384          # header + root directory live in the first 16 KB; tile data follows
UA = 'RimalOffRoad-area-pack/1.0 (personal offline use)'

# ---------------------------------------------------------------- tile maths
def lon2x(lon, z): return (lon + 180.0) / 360.0 * (1 << z)
def lat2y(lat, z):
    r = math.radians(lat); return (1.0 - math.log(math.tan(r) + 1.0 / math.cos(r)) / math.pi) / 2.0 * (1 << z)
def x2lon(x, z): return x / (1 << z) * 360.0 - 180.0
def y2lat(y, z): return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / (1 << z)))))

def dist_km(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = 0.5 - math.cos((lat2 - lat1) * p) / 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * (1 - math.cos((lon2 - lon1) * p)) / 2
    return 12742 * math.asin(math.sqrt(a))

def tiles_in_circle(lat, lon, radius_km, minz, maxz):
    dlat = radius_km / 111.0
    dlon = radius_km / (111.0 * math.cos(math.radians(lat)))
    for z in range(minz, maxz + 1):
        x0, x1 = int(lon2x(lon - dlon, z)), int(lon2x(lon + dlon, z))
        y0, y1 = int(lat2y(lat + dlat, z)), int(lat2y(lat - dlat, z))
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                # nearest point of the tile to the centre
                w, e = x2lon(x, z), x2lon(x + 1, z)
                n, s = y2lat(y, z), y2lat(y + 1, z)
                if dist_km(lat, lon, min(max(lat, s), n), min(max(lon, w), e)) <= radius_km:
                    yield z, x, y

def tileid(z, x, y):   # PMTiles v3 Hilbert tile id
    acc = ((1 << (z * 2)) - 1) // 3
    a = z - 1
    while a >= 0:
        s = 1 << a
        rx, ry = s & x, s & y
        acc += ((3 * rx) ^ ry) << a
        if ry == 0:
            if rx != 0:
                x, y = s - 1 - x, s - 1 - y
            x, y = y, x
        a -= 1
    return acc

# ---------------------------------------------------------------- PMTiles writing
def varint(n, out):
    while n > 0x7F:
        out.append((n & 0x7F) | 0x80); n >>= 7
    out.append(n)

def serialize_dir(entries):
    b = bytearray(); varint(len(entries), b)
    last = 0
    for e in entries: varint(e[0] - last, b); last = e[0]
    for e in entries: varint(e[3], b)
    for e in entries: varint(e[2], b)
    for i, e in enumerate(entries):
        if i > 0 and e[1] == entries[i - 1][1] + entries[i - 1][2]: varint(0, b)
        else: varint(e[1] + 1, b)
    return gzip.compress(bytes(b), 9)

def build_dirs(entries):
    """entries: [tileid, offset, length, run_length] sorted. Returns (root_bytes, leaves_bytes)."""
    limit = DATA_START - 127
    root = serialize_dir(entries)
    if len(root) <= limit: return root, b''
    leaf_size = 4096
    while True:
        roots, leaves = [], bytearray()
        for i in range(0, len(entries), leaf_size):
            chunk = entries[i:i + leaf_size]
            lb = serialize_dir(chunk)
            roots.append([chunk[0][0], len(leaves), len(lb), 0])
            leaves += lb
        root = serialize_dir(roots)
        if len(root) <= limit: return root, bytes(leaves)
        leaf_size = int(leaf_size * 1.2)

def header(root_len, meta_off, meta_len, leaf_off, leaf_len, data_len, addressed, entries, contents, minz, maxz, bounds, center):
    h = b'PMTiles' + bytes([3])
    h += struct.pack('<11Q', 127, root_len, meta_off, meta_len, leaf_off, leaf_len, DATA_START, data_len, addressed, entries, contents)
    h += bytes([0, 2, 1, 3, minz, maxz])   # unclustered, gzip dirs, raw tiles, JPEG
    e7 = lambda v: int(round(v * 1e7))
    h += struct.pack('<4i', e7(bounds[0]), e7(bounds[1]), e7(bounds[2]), e7(bounds[3]))
    h += bytes([center[2]]) + struct.pack('<2i', e7(center[0]), e7(center[1]))
    assert len(h) == 127
    return h

# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description='Build a high-detail satellite pack for Rimal.')
    ap.add_argument('--center', required=True, help='lat,lon e.g. 26.6170,37.9170')
    ap.add_argument('--radius', type=float, default=50, help='radius in km (default 50)')
    ap.add_argument('--maxzoom', type=int, default=18)
    ap.add_argument('--minzoom', type=int, default=8)
    ap.add_argument('--name', default='alula', help='short name used in the file name')
    ap.add_argument('--workers', type=int, default=8)
    ap.add_argument('--url', default=URL, help=argparse.SUPPRESS)
    a = ap.parse_args()
    lat, lon = (float(v) for v in a.center.split(','))

    work = f'rimal-{a.name}-z{a.maxzoom}-r{int(a.radius)}'
    os.makedirs(work, exist_ok=True)
    data_path, db_path = os.path.join(work, 'tiles.bin'), os.path.join(work, 'index.sqlite')
    db = sqlite3.connect(db_path, check_same_thread=False)
    db.execute('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, z INT, off INT, len INT, h TEXT)')
    db.execute('CREATE TABLE IF NOT EXISTS miss (id INTEGER PRIMARY KEY)')
    db.commit()

    print('Working out which tiles cover the circle…', flush=True)
    todo_all = [(z, x, y) for z, x, y in tiles_in_circle(lat, lon, a.radius, a.minzoom, a.maxzoom)]
    have = set(r[0] for r in db.execute('SELECT id FROM t')) | set(r[0] for r in db.execute('SELECT id FROM miss'))
    todo = [t for t in todo_all if tileid(*t) not in have]
    total = len(todo_all)
    print(f'{total:,} tiles in a {a.radius:g} km circle, zoom {a.minzoom}-{a.maxzoom}  ·  {total - len(todo):,} already downloaded  ·  {len(todo):,} to go', flush=True)
    print(f'Expected final size: roughly {total * 17e3 / 1e9:.0f} GB (desert imagery ~17 KB per tile)\n', flush=True)

    if todo:
        # Tile data goes straight into tiles.bin (append-only); the index remembers where each tile is.
        f = open(data_path, 'ab')
        lock = threading.Lock()
        q = queue.Queue()
        for t in todo: q.put(t)
        done = {'n': 0, 'bytes': 0, 'miss': 0, 'err': 0}
        t0 = time.time()
        ctx = ssl.create_default_context()
        stop = threading.Event()

        def fetch(z, x, y):
            delay = 2
            for attempt in range(8):
                try:
                    req = urllib.request.Request(a.url.format(z=z, x=x, y=y), headers={'User-Agent': UA})
                    with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
                        return r.read()
                except urllib.error.HTTPError as e:
                    if e.code in (404, 204): return None
                    if e.code in (403, 429): delay = 30   # being throttled: back off hard
                except ssl.SSLError as e:
                    print(f'\nSSL problem: {e}\nIf you installed Python from python.org, run "Install Certificates.command" in its Applications folder.', flush=True)
                    stop.set(); return None
                except Exception:
                    pass
                if stop.is_set(): return None
                time.sleep(delay); delay = min(delay * 2, 120)
            done['err'] += 1
            return False   # give up for now; a re-run will try again

        def worker():
            while not stop.is_set():
                try: z, x, y = q.get_nowait()
                except queue.Empty: return
                d = fetch(z, x, y)
                tid = tileid(z, x, y)
                with lock:
                    if d:
                        off = f.tell(); f.write(d)
                        db.execute('INSERT OR REPLACE INTO t VALUES (?,?,?,?,?)', (tid, z, off, len(d), hashlib.md5(d).hexdigest()))
                        done['bytes'] += len(d)
                    elif d is None and not stop.is_set():
                        db.execute('INSERT OR REPLACE INTO miss VALUES (?)', (tid,)); done['miss'] += 1
                    done['n'] += 1

        threads = [threading.Thread(target=worker, daemon=True) for _ in range(a.workers)]
        for th in threads: th.start()
        try:
            while any(th.is_alive() for th in threads):
                time.sleep(5)
                with lock:
                    f.flush(); db.commit()
                    n = done['n']; el = time.time() - t0; rate = n / el if el else 0
                    left = (len(todo) - n) / rate if rate else 0
                    print(f'\r  {total - len(todo) + n:,}/{total:,} tiles  ·  {done["bytes"] / 1e9:.2f} GB this run  ·  {rate:.0f} tiles/s  ·  ~{left / 3600:.1f} h left  ', end='', flush=True)
        except KeyboardInterrupt:
            stop.set(); print('\nStopping — run the same command again to continue.', flush=True)
        for th in threads: th.join(timeout=60)
        with lock: f.flush(); db.commit(); f.close()
        if stop.is_set(): sys.exit(1)
        print()
        if done['err']:
            print(f'{done["err"]:,} tiles failed (network). Run the same command again to fetch them, then it will finish.', flush=True)
            sys.exit(1)

    # ------------------------------------------------ assemble the .pmtiles
    print('Packing into one file…', flush=True)
    rows = db.execute('SELECT id, z, off, len, h FROM t ORDER BY id').fetchall()
    # Esri sends the same "no imagery here" picture for gaps: drop any picture repeated 50+ times,
    # so Rimal shows the sharpest lower-zoom imagery there instead.
    counts = {}
    for r in rows: counts[r[4]] = counts.get(r[4], 0) + 1
    junk = {h for h, c in counts.items() if c >= 50}
    rows = [r for r in rows if r[4] not in junk]
    if junk: print(f'  skipped {sum(counts[h] for h in junk):,} placeholder tiles', flush=True)

    date = datetime.date.today().strftime('%Y%m%d')
    out_name = f'ksa-satellite-{a.name}-{date}.pmtiles'
    src = open(data_path, 'rb')
    with open(out_name + '.part', 'wb') as out:
        out.write(b'\0' * DATA_START)
        entries, seen, pos = [], {}, 0
        for tid, z, off, ln, h in rows:
            if h in seen:
                o = seen[h]
            else:
                src.seek(off); out.write(src.read(ln)); o = pos; seen[h] = o; pos += ln
            last = entries[-1] if entries else None
            if last and last[0] + last[3] == tid and last[1] == o and last[2] == ln:
                last[3] += 1          # run of identical tiles
            else:
                entries.append([tid, o, ln, 1])
        data_len = pos
        root, leaves = build_dirs(entries)
        zs = [r[1] for r in rows]
        dlat, dlon = a.radius / 111.0, a.radius / (111.0 * math.cos(math.radians(lat)))
        meta = gzip.compress(json.dumps({'name': f'Satellite {a.name} z{a.maxzoom}', 'rimal_kind': 'satellite', 'attribution': ATTRIBUTION,
                                         'description': f'{a.radius:g} km around {lat:.4f},{lon:.4f}', 'created': date}).encode())
        meta_off = DATA_START + data_len
        out.write(meta); out.write(leaves)
        hdr = header(len(root), meta_off, len(meta), meta_off + len(meta), len(leaves), data_len, len(rows), len(entries), len(seen),
                     min(zs), max(zs), (lon - dlon, lat - dlat, lon + dlon, lat + dlat), (lon, lat, min(15, max(zs))))
        out.seek(0); out.write(hdr + root)
    src.close()
    os.replace(out_name + '.part', out_name)
    print(f'\nDone: {out_name}  ({os.path.getsize(out_name) / 1e9:.2f} GB, {len(rows):,} tiles)')
    print('Copy it to a USB stick (exFAT for files over 4 GB) → Rimal → Maps → Import from USB / more.')
    print(f'You can delete the "{work}" folder once the pack works in Rimal.')

if __name__ == '__main__':
    main()
