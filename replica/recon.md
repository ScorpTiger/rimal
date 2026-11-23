# Recon map: Garmin Overlander (off-road slice) → Rimal

**Scope.** Garmin Overlander / Tread Overland navigators, plus the Garmin Explore app's off-road features.
**Platform.** Android car head unit.
**Slice.** Off-road navigation: maps, imagery, terrain, tracks, trips, waypoints, routes, vehicle angles, POIs and map updates.
**Audience.** The owner's own use in Saudi Arabia.
**Method.** Clean-room, from public sources only. No Garmin software, maps, icons or text are copied. Garmin's maps and imagery are licensed content, so Rimal uses open data instead (see *Cannot clone*).

## Sources

| source | URL | what it gave |
|---|---|---|
| Owner's manual (web) | https://www8.garmin.com/manuals/webhelp/overlander/EN-US/GUID-78DE917B-A8BE-4015-8789-AC0EC160B301-homepage.html | chapter structure |
| Owner's manual (PDF) | https://www8.garmin.com/manuals/webhelp/overlander/EN-GB/Overlander_OM_EN-GB.pdf | off-road tools, map layers, data fields, pitch/roll, track recorder, library, map tools |
| Spec sheet: Overlander | https://cdn.shopify.com/s/files/1/0509/2730/4853/files/Garmin_Product_Specs_-_Overlander.pdf | pitch/roll, sunrise/sunset, road elevations |
| Spec sheet: Overlander (retailer) | https://cdn.shopify.com/s/files/1/0060/4992/3136/files/Overlander.pdf | 3D terrain, downloadable imagery, map updates, iOverlander POIs |
| Garmin blog | https://garmin.com/en-US/blog/?p=29240 | topo, 4x4 roads, pitch/roll positioning |
| Tread Overland listing | https://www.adorama.com/gp0100250800.html | breadcrumbs, BirdsEye over Wi-Fi, campgrounds |
| GearJunkie review | https://gearjunkie.com/technology/garmin-tread-overland-edition-gps-review | real-world use of BirdsEye, inclinometer, app pairing |
| Expedition Portal test | https://expeditionportal.com/field-tested-garmin-tread-xl-overland-edition/ | reconfigurable data screen is the favourite feature |
| EOX Sentinel-2 cloudless | https://eox.at/2024/08/sentinel-2-cloudless-2023/ | open imagery replacing BirdsEye: free non-commercial, zoom 0–14 |

## Screen inventory

| ID | screen | how you get there | purpose | key components | states |
|---|---|---|---|---|---|
| S01 | Map (main) | app launch | live position on topo or imagery | map, position arrow, data fields, map tools, zoom | no GPS, weak GPS, navigating, recording |
| S02 | Map layers | map → layers | toggle topo / BirdsEye / POIs / trip log / 3D | toggles, opacity | no imagery downloaded |
| S03 | Data field picker | long-press a data field | choose what each field shows | list | — |
| S04 | Track recorder | Explore → track | start/pause/save/discard, log interval | buttons, stats | idle, recording, paused |
| S05 | Library | Explore → library | waypoints, tracks, routes, collections | tabs, list, details | empty |
| S06 | Waypoint details | tap waypoint | name, symbol, notes, navigate, delete | form | — |
| S07 | Route editor | Explore → routes → new | place and move points | map + point list, distance | 1 point, editing |
| S08 | Pitch & roll | apps → pitch/roll | vehicle angles, calibrate, warning angle | two gauges, calibrate button | no sensor, warning |
| S09 | ABC (altimeter, barometer, compass) | apps | altitude, pressure, heading, compass calibration | dials | uncalibrated |
| S10 | Map downloads / updates | settings → maps / Wi-Fi | download imagery areas, install map updates | area list, progress, sizes | offline, downloading, failed |
| S11 | Where to → categories | search | POIs (campgrounds, iOverlander, fuel, services) | category grid, results list with distance | no results |
| S12 | Trip data | map tools | odometer, moving time, averages, reset | data grid | — |
| S13 | Elevation ahead | map tools | elevation plot of the route | profile chart | no route |
| S14 | Previous routes ("Where I've Been") | apps | trip log of past drives | map overlay, list | empty |
| S15 | Settings | menu | units, coordinates, display, alerts | lists | — |

## User flows (happy-path tap counts are Garmin's; Rimal's target is the same or fewer)

```
F01 Record a drive and save it              S01 → S04 start → drive → S04 save → name          (4 taps; Rimal: 0 to start (auto), 3 to save)
F02 Retrace a track back to camp            S05 → track → Navigate → reverse? → S01            (4–5; Rimal: TrackBack → Back = 2)
F03 Navigate straight to coordinates        S11 → coordinates → type → Go                      (4; Rimal: Go To → paste → Navigate = 3)
F04 Mark a hazard / camp                    S01 → tap position → save → name                   (3; Rimal: Mark → name = 2)
F05 Download imagery for an area            phone app or Wi-Fi → S10 → pick area → download    (5+; Rimal: Maps → Download this area → Start = 3)
F06 Plan an off-road route                  S07 tap points → save → navigate                   (n+3; Rimal: same)
F07 Check vehicle angles on a slope         apps → S08                                          (2; Rimal: tap the gauge, always on screen = 0)
F08 Find nearest fuel                       S11 → Fuel → pick                                   (3; Rimal: Search → Fuel → ➤ = 3)
F09 Update maps                             connect Wi-Fi → Express/updater → install           (Garmin: manual; Rimal: automatic when online, 0)
edge: no GPS fix, permission denied, storage full, download interrupted, sensor missing, map file corrupt → fall back to the previous version
```

## Components
Map canvas · position arrow · data field tile (configurable) · big tool button · round map button · bottom/side sheet · tabbed list rows · segmented control · toggle row · progress bar · toast · alert banner (warning / success) · navigation banner (arrow, distance, bearing, ETA, off-track) · gauge (pitch/roll dial) · elevation profile chart · coordinate input · map popup (point actions).

## Inferred data model (→ replica-architect)

```
Waypoint   id, name, lon, lat, ele, symbol/colour, notes, created, alertRadius?     evidence: S06, manual "Waypoints"       confidence: high
Track      id, name, points[lon,lat,ele,time], colour, visible, stats                 evidence: S04, S05                       confidence: high
Route      id, name, points[lon,lat], legs                                            evidence: S07                            confidence: high
Collection id, name, member ids                                                       evidence: manual "Library"               confidence: medium
Trip (Rimal) id, name, segments[track], waypoints, notes, stats, start/end            evidence: S14 + user request             confidence: n/a (new)
MapPack    pack, version(date), file, bounds, zoom range, kind                        evidence: S10, "includes map updates"    confidence: medium
ImageryArea id, bbox, zooms, tiles, bytes, created                                   evidence: BirdsEye downloads              confidence: medium
Settings   units, coord format, data fields, warning angles, map view               evidence: S03, S08, S15                   confidence: high
```

## Cannot clone (skip rows in features.csv)
- **Garmin topo maps, BirdsEye imagery, Ultimate Campgrounds, iOverlander and Foursquare data.** These are licensed content. Rimal uses OpenStreetMap, Sentinel-2 cloudless (EOX), AWS open terrain and OSM POIs instead.
- **inReach satellite messaging/SOS and the Garmin Explore cloud sync.** These need Garmin's network and hardware. Rimal offers an SOS screen, SMS of coordinates, and backup/restore files instead.
- **Barometer.** It's hardware that head units don't expose to apps. Rimal shows GPS altitude and terrain-model elevation instead.
- **Live traffic, Fusion stereo and PowerSwitch control.** These rely on partner hardware and services.
- **US trail difficulty ratings and National Parks data.** These are US datasets that don't apply to KSA.
- **Offline turn-by-turn road routing.** It's possible, but needs a routing graph pack and engine. That's a separate project (size L); deferred.

## Size
15 screens, 9 flows, 8 entities. The hard parts are offline imagery at scale (storage and tile licensing), background map updates with safe fallback, and sensor-based pitch/roll on head units without guaranteed sensors. **Size: M** for the slice. Turn-by-turn routing would make it L.
