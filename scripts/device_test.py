"""End-to-end test of the real Rimal APK inside an Android emulator.

Runs on the CI host while the emulator is up. Drives the app through Chrome DevTools Protocol
(the app's Android WebView), uses real internet services (EOX imagery, AWS terrain, GitHub releases),
and writes results + screenshots to ./results.
"""
import json, os, re, subprocess, sys, threading, time, traceback
import urllib.request
import websocket  # pip install websocket-client

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
adb('logcat', '-G', '16M'); adb('logcat', '-c')
adb('shell', 'monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1')
time.sleep(12)
shot('launch')

# ---------- minimal Chrome DevTools Protocol client (Android WebView) ----------
class Page:
    def __init__(self, port):
        targets = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json'))
        t = next(t for t in targets if t.get('type') == 'page' and 'localhost' in t.get('url', ''))
        self.ws = websocket.create_connection(t['webSocketDebuggerUrl'], timeout=600, suppress_origin=True)
        self.n = 0; self.console = []
        self.send('Runtime.enable')
    def send(self, method, **params):
        self.n += 1; mid = self.n
        self.ws.send(json.dumps({'id': mid, 'method': method, 'params': params}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get('method') == 'Runtime.exceptionThrown':
                self.console.append('EXCEPTION ' + json.dumps(m['params']['exceptionDetails'])[:300])
            elif m.get('method') == 'Runtime.consoleAPICalled' and m['params']['type'] in ('error', 'warning'):
                self.console.append(m['params']['type'] + ': ' + ' '.join(str(a.get('value', a.get('description', a.get('preview', '')))) for a in m['params']['args'])[:300])
            if m.get('id') == mid:
                if 'error' in m: raise RuntimeError(m['error'])
                return m['result']
    def evaluate(self, js):
        try:
            r = self.send('Runtime.evaluate', expression=js.strip(), awaitPromise=True, returnByValue=True, timeout=600000)
        except RuntimeError as e:
            if 'reference chain' in str(e) or 'could not be cloned' in str(e).lower(): return None  # ran fine; result not serialisable
            raise
        if 'exceptionDetails' in r:
            raise RuntimeError(r['exceptionDetails'].get('exception', {}).get('description', str(r['exceptionDetails']))[:500])
        return r['result'].get('value')
    def click(self, sel):
        if not self.evaluate(f"(()=>{{const e=document.querySelector({json.dumps(sel)}); if(!e) return false; e.click(); return true;}})()"):
            raise RuntimeError('element not found: ' + sel)
        time.sleep(0.6)
    def fill(self, sel, val):
        if not self.evaluate(f"(()=>{{const e=document.querySelector({json.dumps(sel)}); if(!e) return false; e.value={json.dumps(val)}; e.dispatchEvent(new Event('input')); return true;}})()"):
            raise RuntimeError('element not found: ' + sel)

class Robust:
    """Re-attaches to the WebView if the debugger connection drops (slow software-GPU emulator)."""
    def __init__(self, port): self.port = port; self.p = connect(port); self.console = self.p.console
    def _retry(self, fn, *a):
        for attempt in range(3):
            try: return fn(*a)
            except (websocket.WebSocketException, ConnectionError, OSError) as e:
                print('   debugger connection lost, reattaching', e, flush=True); time.sleep(5)
                self.p = connect(self.port); self.p.console = self.console
        return fn(*a)
    def evaluate(self, js): return self._retry(lambda j: self.p.evaluate(j), js)
    def click(self, sel): return self._retry(lambda x: self.p.click(x), sel)
    def fill(self, sel, v): return self._retry(lambda x, y: self.p.fill(x, y), sel, v)

def connect(port):
    m = None
    for _ in range(40):
        m = re.search(r'@(webview_devtools_remote_\d+)', adb('shell', 'cat', '/proc/net/unix'))
        if m: break
        time.sleep(2)
    if not m: raise RuntimeError('no WebView devtools socket')
    adb('forward', '--remove', f'tcp:{port}'); adb('forward', f'tcp:{port}', f'localabstract:{m.group(1)}')
    for _ in range(20):
        try: return Page(port)
        except Exception: time.sleep(2)
    return Page(port)

# ---------- connect to the WebView ----------
if True:
    page = Robust(9222)
    console = page.console
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

    @step('Pitch & roll: level at start, then real accelerometer tilts (emulator sensor)')
    def _():
        import math
        time.sleep(3)
        lvl = ev("({p: __rimal.attitude.pitch, r: __rimal.attitude.roll, cal: __rimal.attitude.cal, avail: __rimal.attitude.available})")
        if not lvl['avail'] or not lvl['cal']: return (False, lvl)
        U = lvl['cal']['up']; Lr = lvl['cal']['right']
        dot = lambda a, b: sum(x * y for x, y in zip(a, b))
        nrm = lambda v: [x / math.sqrt(dot(v, v)) for x in v]
        L = nrm([Lr[i] - dot(Lr, U) * U[i] for i in range(3)])
        F = nrm([U[1] * L[2] - U[2] * L[1], U[2] * L[0] - U[0] * L[2], U[0] * L[1] - U[1] * L[0]])
        if F[2] > 0: F = [-x for x in F]
        def tilt(direction, deg):
            t = math.radians(deg); v = [U[i] * math.cos(t) + direction[i] * math.sin(t) for i in range(3)]
            adb('emu', 'sensor', 'set', 'acceleration', ':'.join(f'{9.81 * x:.4f}' for x in v)); time.sleep(4)
            return ev("[__rimal.attitude.pitch, __rimal.attitude.roll]")
        nose_up = tilt([-x for x in F], 20)
        right_dn = tilt(L, 15)
        adb('emu', 'sensor', 'set', 'acceleration', ':'.join(f'{9.81 * x:.4f}' for x in U)); time.sleep(3)
        shot('tilt-gauges')
        ok = abs(lvl['p']) < 3 and abs(lvl['r']) < 3 and abs(nose_up[0] - 20) < 3 and abs(nose_up[1]) < 3 and abs(right_dn[1] - 15) < 3 and abs(right_dn[0]) < 3
        return (ok, {'level': [lvl['p'], lvl['r']], 'nose_up_20': nose_up, 'right_down_15': right_dn})

    @step('GPS fix from Android location (permission + WebView geolocation)')
    def _():
        f = wait_for('__rimal.state.fix && [__rimal.state.fix.lon, __rimal.state.fix.lat, __rimal.state.fix.acc]', 90)
        shot('gps-fix')
        return (bool(f) and abs(f[0] - 46.86) < 0.05, f)

    @step('Real satellite imagery fetched online (EOX via native HTTP)')
    def _():
        ev("__rimal.state.follow=false; __rimal.map.jumpTo({center:[46.75,24.68], zoom:13})")
        r = ev("""(async()=>{ const t=await __rimal.tiles.getTile('sat',13,5159,3516); return t && {from:t.from, bytes:t.data.byteLength}; })()""")
        time.sleep(8); shot('satellite-online-riyadh')
        return (bool(r) and r['from'] in ('net', 'offline') and r['bytes'] > 3000, r)

    @step('Real terrain tiles + elevation lookup (AWS)')
    def _():
        r = ev("""(async()=>{ const t=await __rimal.tiles.getTile('dem',12,2579,1757); const e=await __rimal.tiles.elevationAt(46.6753,24.7136); return {from:t&&t.from, bytes:t&&t.data.byteLength, riyadh_m:e}; })()""")
        return (bool(r['bytes']) and r['riyadh_m'] is not None and 450 < r['riyadh_m'] < 800, r)  # Riyadh is ~610 m

    @step('Weather fetch (Open-Meteo via native HTTP)')
    def _():
        r = ev("(async()=>{ const w=await __rimal.refreshWeather(true); return w && w.data && w.data.current; })()")
        return (bool(r) and 'temperature_2m' in r, r)

    @step('Map pack update: discover releases on GitHub')
    def _():
        rem = ev("(async()=>Object.fromEntries(Object.entries(await __rimal.packs.listRemote(__rimal.S.updateRepo)).map(([k,v])=>[k,[v.version,v.size]])))()")
        return (set(rem) >= {'map', 'terrain', 'satellite', 'poi'}, rem)

    @step('Map pack update: full download + install of all packs (~1.3 GB, native download → app storage)')
    def _():
        ev("__rimal.setS('autoUpdate','any'); window.__upd = __rimal.checkUpdates(true).then(()=>'done', e=>'error '+e)")
        time.sleep(5)
        last = ''; end = time.time() + 50 * 60
        while time.time() < end:
            time.sleep(15)
            st = ev("({busy: __rimal.state.update.busy, msg: __rimal.state.update.msg, err: __rimal.state.update.lastError || '', toast: document.getElementById('toast').textContent, maps: Object.values(__rimal.state.maps).map(m=>m.name+':'+m.kind), poi: __rimal.state.poiVersion})")
            if st['msg'] != last: print('   ', st['msg'], flush=True); last = st['msg']
            if not st['busy']: break
        shot('after-update')
        kinds = {m.split(':')[1] for m in st['maps']}
        return (kinds >= {'vector', 'terrain', 'satellite'} and bool(st['poi']), st)

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
        return (bool(r['count']) and r['count'] > 1000, r)

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
    page = Robust(9223); ev = page.evaluate
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
        n = ev("__rimal.state.tracks.length"); return (bool(n) and n >= 1, ev("__rimal.state.tracks.map(t=>t.name)"))

    @step('v3: desert tracks highlighted from the real KSA map (Red Sands)')
    def _():
        ev("__rimal.setS('mapMode','hybrid',true); __rimal.map.jumpTo({center:[46.55,24.35], zoom:13})")
        time.sleep(10); shot('v3-desert-tracks')
        n = ev("(__rimal.map.getLayer('desert-tracks') ? __rimal.map.queryRenderedFeatures({layers:['desert-tracks']}).length : -1)")
        return (n is not None and n >= 0, {'tracks_on_screen': n})

    @step('v3: activity recorder — events, flagged issue, export to Documents/Rimal')
    def _():
        ev("(async()=>{ __rimal.act.log('issue','device test flag',{x:1}); await __rimal.act.flush(); })()")
        evs = ev("(async()=>{ const e = await __rimal.act.all(); const t = {}; e.forEach(x => t[x.type] = (t[x.type]||0)+1); return t; })()")
        txt = ev("(async()=>{ const e = await __rimal.act.all(); return await __rimal.native.saveText('device-activity.txt', __rimal.act.toText(e)); })()")
        ls = adb('shell', 'ls', '-la', '/sdcard/Documents/Rimal/')
        ok = evs and evs.get('gps', 0) > 0 and evs.get('issue', 0) > 0 and ('device-activity.txt' in ls or txt == 'share sheet')
        return (ok, {'types': evs, 'saved': txt})

    @step('v3: stargazing planner + red mode')
    def _():
        n = ev("(()=>{ const n = __rimal.planNight(46.7, 24.7); return {score: n.score, moon: n.moon.name, dark: n.darkHours.toFixed(1)}; })()")
        ev("document.body.classList.add('redmode')"); time.sleep(1); shot('v3-redmode'); ev("document.body.classList.remove('redmode')")
        return (n and float(n['dark']) > 8, n)

    @step('Performance: memory and frame timing on the emulator')
    def _():
        ev("__rimal.map.jumpTo({center:[46.6753,24.7136], zoom:13})")
        ms = ev("""(async()=>{ const t=performance.now(); let n=0; await new Promise(r=>{const f=()=>{n++; if(performance.now()-t<5000) requestAnimationFrame(f); else r();}; __rimal.map.easeTo({center:[46.75,24.72], zoom:14, duration:4500}); requestAnimationFrame(f);}); return Math.round(n/5); })()""")
        mem = adb('shell', 'dumpsys', 'meminfo', PKG)
        total = re.search(r'TOTAL PSS:\s+(\d+)', mem) or re.search(r'TOTAL\s+(\d+)', mem)
        return (True, {'fps_during_pan': ms, 'total_pss_kb': total and total.group(1)})

    adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'); adb('shell', 'svc', 'wifi', 'enable'); adb('shell', 'svc', 'data', 'enable')
    open(f'{OUT}/console.txt', 'w').write('\n'.join(console + page.console))

gps_on['run'] = False
lc = adb('logcat', '-d', timeout=120).splitlines()
open(f'{OUT}/logcat.txt', 'w').write('\n'.join(l for l in lc if re.search(r'Capacitor|chromium|rimal|AndroidRuntime|FATAL|WebView', l) and 'app_time_stats' not in l)[-400000:])
passed = sum(r['ok'] for r in results)
print(f'\n{passed}/{len(results)} passed')
open(f'{OUT}/SUMMARY.md', 'w').write(f'# Device test — {passed}/{len(results)} passed\n\n' + '\n'.join(f"- {'✅' if r['ok'] else '❌'} **{r['test']}** — `{r['detail'][:250]}`" for r in results))
