# Norway Hazard Map

An interactive map for checking whether a Norwegian property sits in a natural
hazard zone: flood, landslide, quick clay, avalanche, rockfall, radon or coastal
storm surge.

Norwegian building rules (TEK17 §7) require you to assess natural hazard
exposure before you build, and the state publishes all of that data for free.
This puts it on one map, so "is this plot safe to build on" takes a few seconds
instead of an afternoon of separate map portals.

Everything runs on open data. There are no API keys anywhere.

Live at https://norway-hazzard-map.vercel.app

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

## What it does

Search an address or click the map, and you get a verdict for six hazard types
at that exact point, plus today's official warning level for the county and the
current weather, yearly rainfall and nearby earthquake history.

When a hazard misses, the report says by how much. "No flood zone here" and "no
flood zone here, the nearest is 350 m away" are very different facts about a
plot, and only one of them is worth acting on.

Switch to Area mode to drop a circle of up to 50 km and count how many mapped
hazard zones fall inside it.

Either report can be exported to PDF. It opens in an overlay and hands itself to
the browser's print dialog, so Save as PDF is the whole flow and there is no
pop-up to unblock. The export includes a topographic map of the location and one
close-up map per hazard that was actually found.

Storm surge is scenario driven rather than a single extent. Pick a return period
and a climate year, and the whole report re-scores against it. A site in Sandnes
sits above today's 200-year surge and inside the same surge once 2100 sea level
rise is added, which is the difference TEK17 expects you to plan for.

On the map itself you can toggle the six hazard layers plus live precipitation
radar, satellite snow cover and recorded earthquakes. The radar, snow and
earthquake layers each have their own timeline, so you can scrub the radar
through the last two hours while earthquakes sit parked in 1994.

Clicks outside Norway say so, rather than reporting "no hazards found" and
implying the site is safe.

## Data sources

| Layer | Source |
| --- | --- |
| Flood zones, landslide and quick clay, snow avalanche, rock avalanche | NVE (`gis3.nve.no`) |
| Radon susceptibility | NGU (`geo.ngu.no`) |
| Storm surge and sea level rise | Kartverket (`wms.geonorge.no`, `wfs.geonorge.no`) |
| Daily flood and landslide warnings | NVE Varsom (`api01.nve.no`) |
| Earthquakes | USGS |
| Weather and rainfall | Open-Meteo |
| Precipitation radar | RainViewer |
| Snow cover | NASA GIBS (MODIS) |
| Addresses and place names | Kartverket |
| Base map | Kartverket topograatone over Esri Light Gray |

## Layout

```
app/
  page.js, layout.js, globals.css   page shell and all styling
  api/risk/          point verdict: 6 hazards + warnings + weather/quakes
  api/area/          circle screening: zone counts, quakes, radon sampling
  api/mapimage/      flattens base map + overlays into one PNG for the PDF
  api/placename/     reverse geocode a point to a place name
  api/geocode/       address search
  api/weather/       radar frame list
  api/earthquakes/   quake history
components/HazardMap.jsx   the map, the UI, and the PDF builder
lib/layers.js              every layer definition lives here
lib/norway-border.js       offline point-in-polygon border check
```

To add or fix a hazard layer, `lib/layers.js` is the only file you need.

## Gotchas

These cost me real time, so they are written down.

**Use `gis3.nve.no/map/rest/services`.** Plenty of tutorials point at
`nve.geodataonline.no`, which no longer resolves at all.

**NVE sublayers are invisible by default.** Most hazard MapServers ship with
every sublayer set to `defaultVisibility=false`, so an `export` request renders
a blank PNG unless you pass `layers=show:<ids>`. Only `Skredfaresoner3` works
without it.

**NVE layers are scale gated.** Flood stops drawing above 1:160 000 and snow
avalanche above 1:80 000, so a wide extent returns an empty image even where
the data exists. Two consequences: the map hides those layers until you zoom in,
and the PDF close-ups shrink their own extent until they clear the threshold.
For counting zones across an area, query the features instead of measuring
pixels, since a query ignores scale entirely.

**A mapped area is not a hazard.** Several services include coverage polygons
(`Dekningskart`, `Kartleggingsomrade`, `Analyseomrade`, `PotensieltSkredfareOmr`)
that only mean "somebody surveyed here". `PotensieltSkredfareOmr` covers most of
the country including open sea. Counting those makes every click report an
avalanche risk.

**Radon needs the class, not the presence.** Every square metre of Norway sits
in some radon polygon. Only `aktsomhetgrad` 2 and 3 (Høy, Særlig høy) are worth
flagging.

**PDF maps are composited on the server for a reason.** Chrome's print
rasterizer can render a translucent, rounded, transformed overlay as its own
layer without the backdrop behind it, which paints a white hole over the map in
the saved PDF while the same page looks perfect on screen. `api/mapimage`
flattens the base map, overlays and markers into one opaque PNG, which the
report then embeds as a data URI. The bug does not reproduce in headless Chrome,
so a screenshot is not enough to test this.

**A flood zone's return period is in the layer name, not its attributes.** The
`gjentaksinterval` field holds the climate year on the climate-adjusted layer, so
`Flomsone_200ar_klima` reports 2100 and reads as a 2100-year flood, which is not
a thing. Parse `Flomsone_(\d+)ar` from the layer name instead.

**Flood-exposed buildings are not a flood zone.** The same service publishes
`Flomutsatte_bygg_*`, the individual buildings that flood, as points. Letting
those set the verdict reports "inside a flood zone" for sites outside every zone.
They are still worth mentioning separately, because the two datasets disagree: at
Drammen a flood-exposed building sits within 50 m of a point whose nearest mapped
zone is 1.9 km away.

**Screen an area with a true circle, and keep the focus point inside it.** A
bounding box over-counts badly (flood 120 zones versus 77, landslide 100 versus
34) and returns features that only clip a corner. ArcGIS takes a point plus
`distance`, which is the real circle. Aiming a detail map needs more care again:
these polygons run far past the query area, so a centroid or a first vertex lands
outside the circle. Measure to the polygon's line segments, since a polygon can
cross the circle with every vertex outside it.

**The storm surge service has its own traps.** `dekningsomrade` returns a feature
at Lillehammer, far inland, so it means "inside the national product" rather than
"surge reaches here". On the WFS, a `urn:ogc:def:crs:EPSG::4326` bbox is lat,lon
and swapping it silently returns zero everywhere. Set `srsName` too: one feature
came back as 1.6 MB in the native CRS and 2.7 KB in 4326.

**This WFS ignores DWithin instead of rejecting it.** The service advertises the
operator, accepts the request and returns all 125 209 features, so a distance
filter looks like it worked while doing nothing. BBOX and Intersects are applied
properly, so screen a circle by polygonising it and using Intersects. A bounding
box is not a substitute: its corners reach r times root two, and at a 5 km radius
near Sandnes the box matched 7 surge polygons where the circle matched none.

**Basemap tiles can fail without failing.** CARTO's keyless `light_all` now
stamps "API KEY REQUIRED" across every tile while still answering 200 with a
valid PNG, so nothing throws, no console warning appears, and the watermark
simply shows up on the map. Kartverket fails the opposite way: outside Norway it
answers 200 with a fully transparent tile, which leaves every neighbouring
country blank. Because those tiles are transparent rather than white, the default
basemap draws Esri's global gray underneath and Kartverket on top, so Norway
keeps its detail and Sweden and Finland still exist.

**Do not open the report in a pop-up.** `window.open` loses to pop-up blockers,
to extensions, and to embedded browsers, and Chrome's transient user activation
expires about 5 seconds after the click, so a slow map composite forfeits the
right to open a window at all. An iframe needs no permission and cannot be
blocked: the report's own script calls `window.print()` inside the frame, so the
dialog covers the frame's document rather than the app around it.

**Kartverket may be unreachable from outside Europe.** From Bangladesh it needs
a Norway VPN. Address search and the daily warnings fail open when it is down,
so everything else keeps working.

**Clear `.next` if edits do not show up.** `next build` and `next dev` share
that directory, and a stale cache serves old chunks.

## Ideas

- Distance to the nearest zone for radon, which needs a different approach since
  every point in Norway is already inside some radon polygon
- Reconcile flood-exposed buildings that no published zone covers
