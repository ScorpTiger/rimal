# Rimal: Off-Road Navigator for Saudi Arabia (v2)

Rimal is an offline-first GPS navigator for Android car head units. Satellite imagery is the default view, maps update themselves whenever the unit is online, and the previous map version is always kept so you have full detail with no signal.

The feature set follows a clean-room study of Garmin Overlander / Tread Overland (`replica/recon.md`, `replica/features.csv`). Garmin's licensed maps and imagery are replaced with open data.

## Features

**Maps and imagery**
- **Satellite view by default.** Choose *Satellite + roads* (hybrid), *Satellite only*, or *Topo*, using the map's layer button.
- **3D terrain, terrain shading and contour lines.** Contours are computed on the unit from elevation data, so they work offline.
- **Every tile you view online is kept** for offline use.
- **Download an area** for full offline detail, choosing the imagery zoom. Downloads resume after an interruption, and **Update** refreshes them later.
- **Never a blank map.** Where you've zoomed past what's stored, Rimal enlarges the best lower-zoom tile it has.
- **Imagery sources:**
  - **Sentinel-2 cloudless (EOX), 10 m.** Free for non-commercial use and covers the whole country. Shows dunes, wadis and escarpments.
  - **Esri World Imagery, sub-metre.** Shows individual tracks. Esri's terms are yours to follow.
  - **Any custom tile URL.**

**Automatic map updates**
- A cloud job builds four packs on the 1st of every month: street & track map (OpenStreetMap), terrain, country-wide satellite, and places & POIs.
- Whenever the unit has internet (Wi-Fi only by default), Rimal checks for new versions, downloads them in the background, verifies them, and switches over.
- **The previous version is always kept.** If a download is damaged or cut off, the current version stays in use. The newest two versions of each pack stay on the unit.

**Trips**
- Recording starts automatically when you move, and saves each point instantly, so a crash or power cut loses nothing.
- A trip records distance, moving time, total time, average and max speed, and climb, with an elevation profile, notes, and the waypoints you marked along the way.
- **Continue a trip** across several days (multi-leg expeditions).
- Export a trip as GPX, including its waypoints.

**Navigation**
- **TrackBack** retraces a trip, and **Follow** drives any trip or route forwards. Both have an off-track alarm.
- **Go To** a waypoint, or to coordinates in any format (decimal, DM, DMS, UTM, Google Maps links).
- **Project a point** by bearing and distance.
- **Route planner and measure tool**: tap points on the map.

**Places**
- **Search** works offline: towns, wells, fuel, camps, mechanics, hospitals, police, mosques and sights, with Arabic and English names.
- **Nearest by category**: tap a category to list the closest ones.

**Vehicle and safety**
- **Pitch and roll gauges**, using the head unit's motion sensor if it has one. Calibrate to level, then set warning angles with a sound alert.
- **Fuel range**: set your full-tank range for a low-fuel alert, the distance to the nearest station, and turn-back / full-range rings on the map.
- **Alerts**: proximity alerts on waypoints (soft sand, hazards, camp), a speed alert, and a sunset warning.
- **SOS screen**: your position in every format, the nearest town, buttons to call 911 or 997, and SMS of your location.
- **Weather**: shown when online, with the last forecast kept for offline. It flags strong gusts (risk of blowing sand).

**Interface and data**
- **Configurable dashboard**: tap any data box to choose what it shows (21 fields).
- **Backup & restore** in one file. Import GPX, KML and GeoJSON.
- Night mode, English or Arabic map labels, metric or imperial units, and layouts for 1024×600 and larger screens, small screens, and portrait.

---

### New in v3
- **Activity recorder** (Settings & tools → 📜 Activity log): a 14-day log on the unit of taps, screens, GPS quality and dropouts, map/download errors, navigation, recordings, freezes, frame rate, memory and battery. Tap **🐞 Flag issue** the moment something goes wrong; export the log afterwards (Documents/Rimal) and send it for analysis. Nothing leaves the device.
- **Stargazing**: astronomical darkness, Moon phase, rise and set, the Moon-free window, Milky Way core timing, a 10-night outlook and a red night-vision screen.
- **Fuel log**: fill-ups with litres and price → L/100 km between full tanks, cost per km and your measured range on a full tank.
- **Trip checklist** with Rimal's own checks (maps installed, weather saved, GPS fix) and a water calculator.
- **Gaia GPS import**: in Gaia, export a track, route, waypoint or a whole folder as GPX, KML or GeoJSON (a folder export arrives as a .zip). In Rimal: Trips → Import and pick the file — .gpx, .kml, .kmz, .geojson and .zip are all accepted, several at once.
- **Extreme-heat warning** from the saved forecast, and **desert tracks** from OpenStreetMap drawn as orange dashes on the imagery.

## Setup (one time, about 30 minutes)

1. **Make a GitHub repository.** Create a free account and a new **public** repository (for example `rimal`), then upload this folder's contents to it.
   - Public is simplest, because the app can then download map updates without a password. The code and the maps contain nothing personal.
   - Private works too: create a read-only access token and paste it in *Maps → Updates & files*.
2. **Build the APK.** In the **Actions** tab, **Build Android APK** runs automatically. Download `Rimal-OffRoad-APK` from the finished run. The APK already knows your repository, so updates work with no setup.
3. **Build the first map packs.** Go to **Actions → Build offline map packs → Run workflow** and keep the defaults. It takes 1–5 hours, then repeats monthly on its own. It publishes releases named `pack-map-…`, `pack-terrain-…`, `pack-satellite-…` and `pack-poi-…`.
4. **Install on the head unit.**
   1. Copy the APK to a USB stick and install it. Allow *Install unknown apps*.
   2. Open Rimal and allow Location.
   3. Connect the unit to Wi-Fi (or your phone's hotspot). The packs download and install by themselves; watch the blue line on the dashboard. Without internet, you can copy the pack files from the Releases page onto a USB stick and use *Maps → Updates & files → Import*.
5. **Before a trip**, while you're still online, pan to where you'll drive and use **Maps → Satellite & areas → Download this area**. Zoom 15–16 suits Sentinel-2. With Esri imagery, zoom 17–18 shows individual tracks.

### Install the maps from a laptop (USB), no internet needed in the car
1. On your laptop, open **https://github.com/ScorpTiger/rimal/releases** and download:
   - `ksa-map.pmtiles` (street & track map, ~1 GB)
   - `ksa-terrain.pmtiles` (terrain)
   - `ksa-poi.json` (places, fuel, water…)
   - `ksa-satellite-nw/ne/sw/se.pmtiles` (all of KSA in satellite imagery at zoom 13, four regions; you can take only the regions you drive in)
2. Copy them to a USB stick formatted **exFAT** or **FAT32** (every file is under 2 GB).
3. In Rimal: **Maps → Updates & files → 📁 Import map files from USB**, select all the files at once, and wait for "Import finished".

### Pack sizes (all of KSA)
| pack | detail | size |
|---|---|---|
| Street & track map | zoom 15 | about 0.5–1.5 GB |
| Terrain | zoom 10 (contours ~every 20–50 m; area downloads go to zoom 12) | about 150–300 MB |
| Satellite overview | zoom 10 (~150 m per pixel) | about 80–150 MB |
| Satellite, all of KSA in 4 regions | zoom 13 (~17 m per pixel, close to Sentinel-2's native 10 m) | about 3 GB in total |
| Places & POIs | — | about 3–10 MB |

High-detail imagery comes from **area downloads**, not the country-wide pack. One 50 × 50 km area at zoom 16 is about 25–40 MB.

### Requirements
- Android 7+ with Android System WebView 100 or newer. Update it if the app says the web engine is too old.
- Free storage of about twice the largest pack while it installs.
- Keep Rimal in the foreground while recording.
- Pitch/roll needs a head unit that exposes a motion sensor. Many do; some don't, and then the gauges stay hidden.

## Data sources and licences
- Map data © OpenStreetMap contributors (ODbL), served via Protomaps.
- Imagery: Sentinel-2 cloudless by EOX IT Services GmbH (contains modified Copernicus Sentinel data). Free for non-commercial use with attribution.
- Terrain: Mapzen / AWS Open Data Terrain Tiles.
- Weather: Open-Meteo.

Using Esri or custom imagery is subject to that provider's terms.

## Project layout
```
src/main.js      UI, map styles, trips, navigation, tools
src/tiles.js     imagery & terrain tiles: packs → on-device cache → internet → upscaled fallback; area downloads; elevation
src/packs.js     map-pack updates: check, download, verify, keep previous version
src/sensors.js   pitch / roll / compass
src/extras.js    sun times, weather cache, POI search, elevation profile
src/geo.js       geodesy, coordinate formats, route matching
src/gpx.js  src/gps.js  src/storage.js  src/native.js
scripts/         pack builders used by the cloud job
.github/workflows/build-apk.yml     builds the APK
.github/workflows/build-packs.yml   monthly offline map packs
replica/         Garmin Overlander feature recon and feature matrix
android/         Android (Capacitor) project
```
