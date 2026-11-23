"""Build a raster .pmtiles pack (satellite imagery or terrain) for an area from an XYZ tile server.

python scripts/build_raster_pack.py --kind terrain --out ksa-terrain.pmtiles --maxzoom 10
python scripts/build_raster_pack.py --kind satellite --out ksa-satellite.pmtiles --maxzoom 10
"""
import argparse, math, sys, time
from concurrent.futures import ThreadPoolExecutor
import requests
from pmtiles.writer import Writer
from pmtiles.tile import zxy_to_tileid, TileType, Compression

SOURCES = {
    'terrain': ('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png', TileType.PNG, 8, 0.0,
                {'rimal_kind': 'terrain', 'encoding': 'terrarium', 'attribution': 'Mapzen / AWS Open Data terrain tiles'}),
    'satellite': ('https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg', TileType.JPEG, 3, 0.15,
                  {'rimal_kind': 'satellite', 'attribution': 'Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024)'}),
}

def tiles(bbox, maxz):
    w, s, e, n = bbox
    for z in range(maxz + 1):
        def x(lon): return int((lon + 180) / 360 * 2 ** z)
        def y(lat):
            r = math.radians(lat); return int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z)
        for tx in range(x(w), x(e) + 1):
            for ty in range(y(n), y(s) + 1):
                yield z, tx, ty

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--kind', required=True, choices=SOURCES)
    ap.add_argument('--out', required=True)
    ap.add_argument('--maxzoom', type=int, default=10)
    ap.add_argument('--bbox', default='34.4,16.2,55.8,32.3')
    ap.add_argument('--url', help='override tile URL template (testing)')
    a = ap.parse_args()
    url, ttype, workers, pause, meta = SOURCES[a.kind]
    url = a.url or url
    bbox = [float(v) for v in a.bbox.split(',')]
    todo = list(tiles(bbox, a.maxzoom))
    print(f'{len(todo)} tiles', flush=True)
    sess = requests.Session(); sess.headers['User-Agent'] = 'RimalOffRoad-pack-builder/2.0'

    def get(t):
        z, x, y = t
        for attempt in range(4):
            try:
                r = sess.get(url.format(z=z, x=x, y=y), timeout=30)
                if r.status_code == 200 and r.content: return t, r.content
                if r.status_code in (204, 404): return t, None
            except requests.RequestException:
                pass
            time.sleep(2 * (attempt + 1))
        return t, None

    got = {}
    with ThreadPoolExecutor(workers) as ex:
        for i, (t, data) in enumerate(ex.map(get, todo)):
            if data: got[zxy_to_tileid(*t)] = data
            if pause: time.sleep(pause / workers)
            if i % 2000 == 0: print(f'{i}/{len(todo)}', flush=True)
    if len(got) < len(todo) * 0.9:
        sys.exit(f'Only {len(got)} of {len(todo)} tiles downloaded — not publishing a partial pack')
    with open(a.out, 'wb') as f:
        w = Writer(f)
        for tid in sorted(got): w.write_tile(tid, got[tid])
        w.finalize({'tile_type': ttype, 'tile_compression': Compression.NONE, 'min_zoom': 0, 'max_zoom': a.maxzoom,
                    'min_lon_e7': int(bbox[0] * 1e7), 'min_lat_e7': int(bbox[1] * 1e7), 'max_lon_e7': int(bbox[2] * 1e7), 'max_lat_e7': int(bbox[3] * 1e7),
                    'center_zoom': 6, 'center_lon_e7': int(45e7), 'center_lat_e7': int(24e7)}, meta)
    print('wrote', a.out, len(got), 'tiles')

if __name__ == '__main__':
    main()
