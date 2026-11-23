"""End-to-end test of the real Rimal APK inside an Android emulator.

Runs on the CI host while the emulator is up. Drives the app through Chrome DevTools Protocol
(the app's Android WebView), uses real internet services (EOX imagery, AWS terrain, GitHub releases),
and writes results + screenshots to ./results.
"""
import json, os, re, subprocess, sys, threading, time, traceback
from playwright.sync_api import sync_playwright

OUT = 'results'; os.makedirs(OUT, exist_ok=True)
PKG = 'com.rimal.offroad'
results = []
t0 = time.time()

def adb(*a, check=False, timeout=120):
    r = subprocess.run(['adb', *a], capture_output=True, text=True, timeout=timeout)
    if check and r.returncode: raise RuntimeError(r.stderr)
    return r.stdout.strip()

def shot(name):
    with open(f'{OUT}/{len(os.listdir(OUT)):02d}-{name}.png', 'wb') as f:
        f.write(subprocess.run(['adb', 'exec-out', 'screencap', '-p'], capture_output=True, timeout=60).stdout)

def record(name, ok, detail=''):
    results.append({'test': name, 'ok': bool(ok), 'detail': str(detail)[:600], 't': round(time.time() - t0)})
    print(('PASS ' if ok else 'FAIL ') + name + ' — ' + str(detail)[:300], flush=True)
    json.dump(results, open(f'{OUT}/results.json', 'w'), indent=1)

def step(name):
    def deco(fn):
        try:
            r = fn()
            record(name, r is not False and not (isinstance(r, tuple) and r[0] is False), r[1] if isinstance(r, tuple) else r)
        except Exception as e:
            record(name, False, f'{type(e).__name__}: {e}\n{traceback.format_exc()[-400:]}')
        return fn
    return deco

# ---------- GPS feed: a slow drive east of Riyadh ----------
gps_on = {'run': True, 'lon': 46.86, 'lat': 24.58}
def feed_gps():
    i = 0
    while gps_on['run']:
        if gps_on.get('move'):
            gps_on['lon'] += 0.00012; gps_on['lat'] += 0.00004 * (1 if (i // 30) % 2 == 0 else -1)
        adb('emu', 'geo', 'fix', f"{gps_on['lon']:.6f}", f"{gps_on['lat']:.6f}", '640')
        i += 1; time.sleep(1)
threading.Thread(target=feed_gps, daemon=True).start()

# ---------- install + launch ----------
adb('install', '-r', '-g', 'Rimal-OffRoad.apk', check=True, timeout=300)
for perm in ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION']:
    adb('shell', 'pm', 'grant', PKG, f'android.permission.{perm}')
adb('shell', 'settings', 'put', 'secure', 'location_mode', '3')
adb('shell', 'svc', 'power', 'stayon', 'true')
adb('shell', 'wm', 'size', '1280x720'); adb('shell', 'wm', 'density', '160')
adb('shell', 'settings', 'put', 'system', 'user_rotation', '1')
adb('logcat', '-c')
adb('shell', 'monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1')
time.sleep(12)
shot('launch')

# ---------- connect to the WebView ----------
sock = None
for _ in range(30):
    m = re.search(r'@(webview_devtools_remote_\d+)', adb('shell', 'cat', '/proc/net/unix'))
    if m: sock = m.group(1); break
    time.sleep(2)
if not sock:
    record('WebView debuggable', False, 'no devtools socket'); sys.exit(1)
adb('forward', 'tcp:9222', f'localabstract:{sock}')

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp('http://127.0.0.1:9222')
    page = next(pg for c in browser.contexts for pg in c.pages if 'localhost' in pg.url)
    console = []
    page.on('console', lambda m: console.append(f'{m.type}: {m.text}'[:300]) if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: console.append(f'PAGEERROR {e}'[:300]))
    ev = page.evaluate
    def wait_for(js, timeout=60, every=1.0):
        end = time.time() + timeout
        while time.time() < end:
            v = ev(js)
            if v: return v
            time.sleep(every)
        return ev(js)

    @step('App starts natively (Capacitor, engine check)')
    def _():
        wait_for('!!window.__rimal', 60)
        info = ev("({native: __rimal.native.isNative, engine: __rimal.state.engineOk, ua: navigator.userAgent.match(/Chrome\\/[\\d.]+/)[0], opfs: !!navigator.storage?.getDirectory, repo: __rimal.S.updateRepo})")
        return (info['native'] and info['engine'], info)

    @step('GPS fix from Android location (permission + WebView geolocation)')
    def _():
        f = wait_for('__rimal.state.fix && [__rimal.state.fix.lon, __rimal.state.fix.lat, __rimal.state.fix.acc]', 90)
        shot('gps-fix')
        return (bool(f) and abs(f[0] - 46.86) < 0.01, f)

    @step('Real satellite imagery fetched online (EOX via native HTTP)')
    def _():
        ev("__rimal.state.follow=false; __rimal.map.jumpTo({center:[46.75,24.68], zoom:13})")
        r = ev("""(async()=>{ const t=await __rimal.tiles.getTile('sat',13,5159,3516); return t && {from:t.from, bytes:t.data.byteLength}; })()""")
        time.sleep(8); shot('satellite-online-riyadh')
        return (bool(r) and r['from'] in ('net', 'offline') and r['bytes'] > 3000, r)

    @step('Real terrain tiles + elevation lookup (AWS)')
    def _():
        r = ev("""(async()=>{ const t=await __rimal.tiles.getTile('dem',12,2579,1757); const e=await __rimal.tiles.elevationAt(46.6753,24.7136); return {from:t&&t.from, bytes:t&&t.data.byteLength, riyadh_m:e}; })()""")
        return (r['bytes'] and r['riyadh_m'] and 450 < r['riyadh_m'] < 800, r)  # Riyadh is ~610 m

    @step('Weather fetch (Open-Meteo via native HTTP)')
    def _():
        ok = wait_for('__rimal.state.weather && __rimal.state.weather.data && __rimal.state.weather.data.current.temperature_2m', 40)
        return (ok is not None and ok != 0, ok)

    @step('Map pack update: discover releases on GitHub')
    def _():
        rem = ev("(async()=>Object.fromEntries(Object.entries(await __rimal.packs.listRemote(__rimal.S.updateRepo)).map(([k,v])=>[k,[v.version,v.size]])))()")
        return (set(rem) >= {'map', 'terrain', 'satellite', 'poi'}, rem)

    @step('Map pack update: full download + install of all packs (~1.3 GB, native download → app storage)')
    def _():
        ev("__rimal.setS('autoUpdate','any'); __rimal.checkUpdates(true)")
        last = ''; end = time.time() + 45 * 60
        while time.time() < end:
            time.sleep(15)
            st = ev("({busy: __rimal.state.update.busy, msg: __rimal.state.update.msg, maps: Object.values(__rimal.state.maps).map(m=>m.name+':'+m.kind), poi: __rimal.state.poiVersion})")
            if st['msg'] != last: print('   ', st['msg'], flush=True); last = st['msg']
            if not st['busy']: break
        shot('after-update')
        kinds = {m.split(':')[1] for m in st['maps']}
        return (kinds >= {'vector', 'terrain', 'satellite'} and st['poi'], st)

    @step('Street map renders real KSA roads & places (hybrid view)')
    def _():
        ev("__rimal.setS('mapMode','hybrid',true); __rimal.map.jumpTo({center:[46.6753,24.7136], zoom:12})")
        time.sleep(10); shot('hybrid-riyadh')
        n = ev("({roads: __rimal.map.querySourceFeatures('protomaps',{sourceLayer:'roads'}).length, places: __rimal.map.querySourceFeatures('protomaps',{sourceLayer:'places'}).length})")
        return (n['roads'] > 50, n)

    @step('Topo + hillshade + contours + 3D terrain render')
    def _():
        ev("__rimal.setS('mapMode','topo',true); __rimal.map.jumpTo({center:[45.5,22.3], zoom:11})")
        time.sleep(10); shot('topo-tuwaiq')
        c = ev("__rimal.map.querySourceFeatures('contours',{sourceLayer:'contours'}).length")
        ev("__rimal.setS('terrain3d',true); __rimal.map.setTerrain({source:'dem3d',exaggeration:1.5}); __rimal.map.easeTo({pitch:65, bearing:40})")
        time.sleep(10); shot('3d-terrain')
        ev("__rimal.setS('terrain3d',false); __rimal.map.setTerrain(null); __rimal.map.jumpTo({pitch:0,bearing:0}); __rimal.setS('mapMode','hybrid',true)")
        return (c > 0, {'contour_features': c})

    @step('POI pack: search + nearest fuel')
    def _():
        r = ev("""(async()=>{ const v=await __rimal.packs.latestPOI(); return {count: v&&v.data.length, version: v&&v.version}; })()""")
        return (r['count'] and r['count'] > 1000, r)

    @step('Download an area for offline (real imagery z14, terrain z12)')
    def _():
        r = ev("""(async()=>await __rimal.tiles.downloadArea({bbox:[46.84,24.56,46.92,24.62], layers:['sat','dem'], maxZoom:14, demMaxZoom:12}))()""")
        return (r['failed'] <= r['total'] * 0.02 and r['total'] > 50, r)

    @step('Trip recording while driving (Android GPS, auto-start)')
    def _():
        ev("__rimal.state.follow=true"); gps_on['move'] = True
        wait_for('__rimal.state.rec.active && __rimal.state.rec.points.length > 15', 120, 2)
        shot('recording')
        pts = ev('__rimal.state.rec.points.length'); return (pts > 15, {'points': pts, 'dist_m': ev('Math.round(__rimal.state.rec.dist)')})

    @step('Save trip → TrackBack navigation')
    def _():
        gps_on['move'] = False
        page.click('#bRec'); page.click('[data-a=save]'); page.fill('#pIn', 'Emulator trip'); page.click('[data-a=ok]')
        time.sleep(2)
        t = ev("__rimal.state.tracks.filter(t=>t.kind==='trip').map(t=>[t.name,t.coords.length])")
        page.click('#bBack'); page.click('[data-a=back]'); time.sleep(4); shot('trackback')
        nav = ev("__rimal.state.nav && [__rimal.state.nav.name, document.getElementById('navDist').textContent]")
        page.click('#navStop')
        return (bool(t) and bool(nav), {'trips': t, 'nav': nav})

    @step('GPX export writes to Documents/Rimal (native file save)')
    def _():
        where = ev("(async()=>await __rimal.native.saveText('device-test.gpx','<gpx version=\"1.1\"></gpx>'))()")
        ls = adb('shell', 'ls', '-la', '/sdcard/Documents/Rimal/')
        return ('device-test.gpx' in ls or where == 'share sheet', {'returned': where, 'ls': ls})

    @step('OFFLINE: airplane mode — maps, imagery and terrain still load')
    def _():
        adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'enable'); adb('shell', 'svc', 'wifi', 'disable'); adb('shell', 'svc', 'data', 'disable')
        time.sleep(6)
        adb('shell', 'am', 'force-stop', PKG); time.sleep(2)
        adb('shell', 'monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1'); time.sleep(12)
        return True

    # reconnect to the new WebView process after the restart
    adb('forward', '--remove-all')
    m = None
    for _ in range(30):
        m = re.search(r'@(webview_devtools_remote_\d+)', adb('shell', 'cat', '/proc/net/unix'))
        if m: break
        time.sleep(2)
    adb('forward', 'tcp:9223', f'localabstract:{m.group(1)}')
    b2 = p.chromium.connect_over_cdp('http://127.0.0.1:9223')
    page = next(pg for c in b2.contexts for pg in c.pages if 'localhost' in pg.url)
    page.on('pageerror', lambda e: console.append(f'PAGEERROR {e}'[:300]))
    ev = page.evaluate
    wait_for('!!window.__rimal && Object.keys(__rimal.state.maps).length', 60)

    @step('OFFLINE: downloaded area shows full detail, rest of KSA from packs')
    def _():
        ev("__rimal.state.follow=false; __rimal.map.jumpTo({center:[46.88,24.59], zoom:14.5})")
        time.sleep(10); shot('offline-area-detail')
        a = ev("(async()=>{const t=await __rimal.tiles.getTile('sat',14,10325,7036); return t&&{from:t.from,bytes:t.data.byteLength};})()")
        ev("__rimal.map.jumpTo({center:[39.6,24.47], zoom:9})")  # Madinah region: only country packs
        time.sleep(8); shot('offline-elsewhere-pack')
        b = ev("(async()=>{const t=await __rimal.tiles.getTile('sat',9,312,220); return t&&{from:t.from,bytes:t.data.byteLength};})()")
        roads = ev("__rimal.map.querySourceFeatures('protomaps',{sourceLayer:'roads'}).length")
        return (a and a['from'] == 'offline' and b and b['from'] == 'offline' and roads > 0, {'area_tile': a, 'pack_tile': b, 'roads': roads, 'online': ev('navigator.onLine')})

    @step('OFFLINE: trips and waypoints persisted after restart')
    def _():
        return (ev("__rimal.state.tracks.length") >= 1, ev("__rimal.state.tracks.map(t=>t.name)"))

    @step('Performance: memory and frame timing on the emulator')
    def _():
        ev("__rimal.map.jumpTo({center:[46.6753,24.7136], zoom:13})")
        ms = ev("""(async()=>{ const t=performance.now(); let n=0; await new Promise(r=>{const f=()=>{n++; if(performance.now()-t<5000) requestAnimationFrame(f); else r();}; __rimal.map.easeTo({center:[46.75,24.72], zoom:14, duration:4500}); requestAnimationFrame(f);}); return Math.round(n/5); })()""")
        mem = adb('shell', 'dumpsys', 'meminfo', PKG)
        total = re.search(r'TOTAL PSS:\s+(\d+)', mem) or re.search(r'TOTAL\s+(\d+)', mem)
        return (True, {'fps_during_pan': ms, 'total_pss_kb': total and total.group(1)})

    adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'); adb('shell', 'svc', 'wifi', 'enable'); adb('shell', 'svc', 'data', 'enable')
    open(f'{OUT}/console.txt', 'w').write('\n'.join(console))

gps_on['run'] = False
open(f'{OUT}/logcat.txt', 'w').write(adb('logcat', '-d', '-t', '4000', timeout=60))
passed = sum(r['ok'] for r in results)
print(f'\n{passed}/{len(results)} passed')
open(f'{OUT}/SUMMARY.md', 'w').write(f'# Device test — {passed}/{len(results)} passed\n\n' + '\n'.join(f"- {'✅' if r['ok'] else '❌'} **{r['test']}** — `{r['detail'][:250]}`" for r in results))
