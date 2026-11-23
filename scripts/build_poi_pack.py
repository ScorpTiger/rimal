"""Build the offline Places & POIs pack for Saudi Arabia from OpenStreetMap (Overpass API).
Output: JSON array of [lon, lat, category, name_en_or_name, name_ar]
"""
import json, sys, time, requests

CATS = {
    'fuel': ['nwr["amenity"="fuel"]'],
    'water': ['nwr["amenity"="drinking_water"]', 'nwr["man_made"="water_well"]', 'nwr["natural"="spring"]', 'nwr["man_made"="water_tap"]'],
    'camp': ['nwr["tourism"~"camp_site|caravan_site"]'],
    'repair': ['nwr["shop"~"car_repair|tyres|car_parts"]', 'nwr["amenity"="car_repair"]'],
    'hospital': ['nwr["amenity"~"hospital|clinic"]'],
    'police': ['nwr["amenity"="police"]'],
    'food': ['nwr["shop"~"supermarket|convenience"]', 'nwr["amenity"~"restaurant|fast_food|cafe"]'],
    'mosque': ['nwr["amenity"="place_of_worship"]["religion"="muslim"]'],
    'place': ['node["place"~"city|town|village|hamlet|locality|isolated_dwelling"]'],
    'sight': ['nwr["natural"~"peak|cave_entrance|sand|dune|valley|rock|arch"]["name"]', 'nwr["tourism"~"viewpoint|attraction"]', 'nwr["historic"]["name"]'],
}
URL = 'https://overpass-api.de/api/interpreter'

def run(cat, sels):
    body = '[out:json][timeout:900];area["ISO3166-1"="SA"][admin_level=2]->.a;(' + ''.join(f'{s}(area.a);' for s in sels) + ');out center tags;'
    for attempt in range(5):
        r = requests.post(URL, data={'data': body}, timeout=1000, headers={'User-Agent': 'RimalOffRoad-pack-builder/2.0'})
        if r.status_code == 200: return r.json()['elements']
        print(cat, 'retry', r.status_code, flush=True); time.sleep(60 * (attempt + 1))
    sys.exit(f'Overpass failed for {cat}')

out = []
for cat, sels in CATS.items():
    els = run(cat, sels)
    for e in els:
        lon = e.get('lon') or e.get('center', {}).get('lon'); lat = e.get('lat') or e.get('center', {}).get('lat')
        if lon is None: continue
        t = e.get('tags', {})
        out.append([round(lon, 6), round(lat, 6), cat, t.get('name:en') or t.get('name') or '', t.get('name:ar') or ''])
    print(cat, len(els), flush=True)
    time.sleep(5)
json.dump(out, open(sys.argv[1] if len(sys.argv) > 1 else 'ksa-poi.json', 'w'), ensure_ascii=False, separators=(',', ':'))
print('total', len(out))
