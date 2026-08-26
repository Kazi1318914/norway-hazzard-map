# Norway Hazard Map 🇳🇴

An interactive web map of Norway's **natural-hazard zones** — flood, quick-clay
landslide, snow avalanche, rockfall and debris-flood — for screening
real-estate sites. Built on **open government data** (no API keys, no cost).

> Why this matters: Norwegian building regulations (TEK17 §7) require that you
> assess natural-hazard exposure before you build. This map makes that exposure
> visible at a glance.

## Data sources (all free, no key)

All hazard services are hosted at **`https://gis3.nve.no/map/rest/services`**
(verified live). The map calls each service's ArcGIS REST `export` endpoint, so
**you host no data** — overlays render straight from NVE's servers.

| Layer | Source | Service |
|---|---|---|
| Flood zones | NVE | `Mapservices/FlomsoneKart2` |
| Landslide & quick-clay zones | NVE | `Skredfaresoner3` |
| Snow avalanche susceptibility | NVE | `SnoskredAktsomhet` |
| Rock avalanche | NVE | `Fjellskred1` |
| Radon susceptibility | NGU | `RadonWMS2` (WMS, no key) |
| Live flood/landslide warnings | NVE Varsom | `api01.nve.no` warning API |
| Precipitation radar (live) | RainViewer | `weather-maps.json` (no key) |
| Snow cover (satellite) | NASA GIBS | `MODIS_Terra_NDSI_Snow_Cover` (no key) |
| Earthquakes (M2+, since 1990) | USGS | `fdsnws/event` GeoJSON (no key) |
| Address search | Kartverket | `ws.geonorge.no/adresser` (no key) |
| Basemap | Kartverket / Carto | `topograatone` / `light_all` |

> Heads-up: `nve.geodataonline.no` (an older NVE host) no longer resolves —
> if you find tutorials using it, swap in `gis3.nve.no/map/rest/services`.

## Run it

```bash
cd norway-hazard-map
npm install
npm run dev
# open http://localhost:3000
```

## Project layout

```
lib/layers.js          ← all data sources live here (edit this to add/fix layers)
components/HazardMap.jsx ← MapLibre map + layer toggles + legend
app/page.js            ← loads the map client-side (MapLibre needs window)
app/layout.js          ← page shell + metadata
app/globals.css        ← styling
```

To **add a hazard layer**: copy a block in `lib/layers.js`, change `id`,
`label`, `color`, and the service name. Browse more NVE services at
<https://nve.geodataonline.no/arcgis/rest/services>.

## Verify / browse the endpoints

To confirm a service or find new ones:

```bash
# List every NVE hazard service:
curl -s "https://gis3.nve.no/map/rest/services?f=json"
curl -s "https://gis3.nve.no/map/rest/services/Mapservices?f=json"

# Check one service returns a PNG (200 + image/png):
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
  "https://gis3.nve.no/map/rest/services/Mapservices/FlomsoneKart2/MapServer/export?bbox=445278,7741000,3450000,11800000&bboxSR=3857&imageSR=3857&size=512,512&format=png32&transparent=true&f=image"
```

Browse the full catalog in a browser at
<https://gis3.nve.no/map/rest/services>, then update `lib/layers.js`.

If the Kartverket basemap looks blank, switch to the **Carto Light** fallback in
the basemap dropdown, or check the current tile URL at
<https://kartkatalog.geonorge.no>.

## Click-to-score (done ✓)

Click anywhere on the map → a red marker drops and a verdict card scores the
point against **all four hazard layers**: **flood**, **landslide & quick-clay**,
**snow avalanche**, and **rock avalanche**.

Each check excludes NVE "coverage / assessment-area" layers (e.g.
`Dekningskart`, `Analyseomrade`, `PotensieltSkredfareOmr`) so being inside a
*mapped* area isn't mistaken for being inside an actual *hazard zone*.

The five hazard checks are **flood, landslide & quick-clay, snow avalanche, rock
avalanche, and radon**. Radon reads the NGU class via WMS GetFeatureInfo (GML)
and only flags `aktsomhetgrad ≥ 2` (Høy / Særlig høy) — *Moderat til lav* and
*Usikker* areas are reported but not flagged. The rest use NVE ArcGIS `identify`.

The card then shows **today's live warnings** (Varsom flood + landslide danger
level for the point's county, via a Kartverket point→county lookup) and a
**context** block (informational, not pass/fail):

- **Weather now** — current temp / conditions / wind + **gusts** ([Open-Meteo](https://open-meteo.com), no key)
- **Climate** — total precipitation over the past year (Open-Meteo archive)
- **Earthquakes** — count + nearest M2+ quake within 50 km (USGS), over the
  **same window as the earthquake timeline** (default last 12 months, or the
  "from year" you set). The client passes that window start to `/api/risk`.

All run server-side in `/api/risk` in parallel with the hazard checks.

The card can be **minimized** (— collapses to just the verdict header) and
**exported to PDF** (⤓ PDF opens a clean printable report → Save as PDF).

Each hazard layer shows the **zoom level it's visible at** (e.g. flood zones
"visible at zoom 9+"), with a live zoom readout and a "🔍 Zoom in to see" nudge
when an enabled layer needs more zoom.

How it works: the browser calls `/api/risk?lng=..&lat=..`
([app/api/risk/route.js](app/api/risk/route.js)), which queries NVE's ArcGIS
`identify` endpoint **server-side** (avoids browser CORS) for each hazard
service and returns a clean verdict. Try **Lillestrøm** (`11.05, 59.955`) for a
flood hit, or **Trondheim** for quick-clay.

## Norway-only gate (done ✓)

Clicks outside Norway return *"Outside Norway — this map only covers Norwegian
data"* instead of a misleading "✓ no hazards". The check is an **offline
point-in-polygon** against a bundled Norway boundary
([lib/norway-border.js](lib/norway-border.js), ~110 m precision, + Svalbard /
Jan Mayen boxes) — no dependency on a flaky external API, so an outage can't
falsely flag all of Norway as "outside".

## Area screening — draw a circle (done ✓)

A **Point / Area** mode toggle. In Area mode, click the map to drop a circle
(radius slider, max 50 km) and get a regional breakdown via
[/api/area](app/api/area/route.js):

- **Hazard zones** — how many mapped zones of each hazard intersect the circle,
  via scale-independent ArcGIS `query` (count). (Pixel-% coverage was dropped:
  most NVE layers are `minScale`-gated and don't render at a 25–50 km extent.)
- **Earthquakes** — count + strongest within the radius (USGS, radius-native).
- **Radon** — class sampled at the centre + 4 points.

> Important NVE quirk: most hazard MapServers have **all sublayers
> `defaultVisibility=false`**, so the `export` renders nothing unless the URL
> passes `layers=show:<ids>` (see `nveExport` in [lib/layers.js](lib/layers.js)).
> Flood/snow/rock are also `minScale`-gated, hence the per-layer zoom hints.

The circle complements the point score; switching modes clears the other. The
map auto-zooms to frame the chosen radius, and the area card can be minimized or
exported to PDF (earthquakes in the area honour the same window as the
earthquake timeline).

## PDF reports

Both the point and area cards export a styled PDF (browser print → Save as PDF):
a branded header, a **Kartverket topo map image** of the location (with NVE
hazard overlays + a centre marker / area circle), the hazard findings table,
live warnings / context, and a linked **Data sources** section.

### The map is composited server-side — and why

The report map is built by [/api/mapimage](app/api/mapimage/route.js): it fetches
the Kartverket base PNG plus any hazard-overlay PNGs, alpha-composites them with
`pngjs`, draws the dashed ring and centre pin **into the pixels**, and returns
one **fully opaque** PNG (`colorType: 2`). The client inlines it as a `data:` URI.

This is not gold-plating. The report map used to be a stack of
absolutely-positioned cross-origin `<img>`s plus a CSS circle that combined
`transform`, `border-radius` and a translucent `background`. Chrome's print
rasterizer promotes such an element to its own composited layer and can
rasterize it **without its backdrop** — the layer's white backing then painted
over the map, so the saved PDF showed a white disc while the same page looked
perfect on screen. Flattening to a single opaque bitmap removes the whole class
of failure: no transparency, no transforms, no stacking contexts, and no network
at print time.

Note: this reproduces only in *interactive* Chrome. Headless
`--print-to-pdf` uses a software compositing path and renders the old markup
correctly, so it cannot be used to verify this specific fix.

`pdfMapImageFallback` keeps a hardened version of the old cross-origin stack
(stroke-only SVG decor, no translucent fill) for when the composite endpoint is
unreachable; the card then shows "Map composite unavailable — used a basic map."

Because the composite takes a moment, the PDF button shows a spinner and
disables while working, and the report window is opened **synchronously** before
the fetch — Chrome's transient user activation expires in ~5 s, so opening it
afterwards would be blocked.

### Report pagination

The report is laid out as three page groups so nothing important gets split:

1. header + overview map + hazard table
2. **all detail maps** (`.detail-page` starts a new page; each `.dfig` has
   `break-inside:avoid`, so a 2-up row that doesn't fit moves whole to page 3)
3. **context + data sources + disclaimer** (`.tail-page`), grouped so the
   sources list can't strand a single bullet on a final page

Two sizing constraints exist purely to make that work: `.mapwrap` is capped at
**150 mm** (at the 760 px body width the overview map printed ~188 mm tall and
pushed the hazard table onto its own page, orphaning one row), and `table` has
`break-inside:avoid` as a backstop. The tail only forces a page break when
detail maps exist, so a clean site doesn't get a near-empty page.

### Per-hazard detail maps

Below the overview map, the report adds **one detail map per hazard actually
present** (a clean site gets none, keeping the PDF small).

Spans are capped at `DETAIL_MAX_KM` (20 km). Without that, an *ungated* layer
like landslide would reuse the full requested extent — on a 50 km circle that
produced a 115 km-wide "detail" map, wider than the circle itself.

Each thumbnail **auto-zooms to a scale where its layer actually renders**. NVE
suppresses several sublayers above a scale threshold — flood at 1:160 000, snow
avalanche at 1:80 000, rock avalanche at 1:320 000 (recorded as `maxScale` in
[lib/layers.js](lib/layers.js)) — so a wide extent silently returns an empty
PNG. `detailHalfFor()` shrinks the extent until it clears that gate, which is
why the thumbnails differ in span (flood ≈15 km, snow ≈7.5 km) and why each
caption states its own scale.

For the **area** report the circle itself (25–50 km ≈ 1:565 000) is far above
every gate, so a full-circle hazard map is impossible — rendering one would need
a ~2700 px raster. Instead each detail map is aimed at where that hazard
actually is, using a focus point from [/api/area](app/api/area/route.js), and the
caption says so ("detail near Fretheim — not the full circle").

Captions name the place rather than printing coordinates, via
[/api/placename](app/api/placename/route.js) (Kartverket stedsnavn). That
register is extremely granular — the *closest* name to an arbitrary point is
often a single boulder or knoll ("Vatnasteinane", type `Stein`) — so candidates
are ranked by feature **type** first (settlement → farm → landform) and only
then by distance. When the chosen name is ≥1.2 km away the caption keeps the
distance visible ("detail 1.9 km from Vikesland") so a nearby label can't be
misread as the exact spot; if nothing resolves it falls back to coordinates.

That focus point is the ring centroid of **one real feature**, not the bounding
box of all matches: with features scattered around a 25 km circle the bbox
centre usually lands in a gap between them. Measured on snow avalanche at
Lillestrøm, the bbox centre rendered **0.01 %** hazard coverage versus **1.94 %**
for a real feature — i.e. the difference between a blank thumbnail and a useful
one.

### Writing style in the report

Report copy is kept plain and free of the usual generated-text tells. Concretely:
no em or en dashes, straight quotes, no bolded label-and-value lists (the data
sources are written as a paragraph), real sentences instead of fragments like
"Screening only" or "lookup failed", and proper plurals rather than "zone(s)".
Headings say what they contain ("Conditions and history", not "Context").

Locations are named, not numbered. The area report header reads "Centred on
Fretheim, Aurland (60.85780, 7.10960), covering everything within 50 km" with
the coordinates kept in brackets so the area is still reproducible. Norwegian
radon classes are glossed for readers who don't speak Norwegian, e.g. *Usikker
aktsomhet (uncertain, not surveyed in detail)*.

### Weather and earthquake reporting

- **Weather** is stamped with its observation time in the site's own timezone
  (Open-Meteo `timezone=auto`), e.g. *"Weather at 2026-08-22 12:45 GMT+2"* — a
  reading without a timestamp is not interpretable.
- **Earthquakes** report the **most recent** event rather than the nearest or
  strongest, e.g. *"Most recent: M3.9, 12 km away on 2026-04-26"*, since "has
  anything happened here lately" is the question a reader actually has.

## Address search (done ✓)

Type an address → debounced lookup via `/api/geocode`
([app/api/geocode/route.js](app/api/geocode/route.js), proxying Kartverket) →
pick a result → the map flies there, drops a marker, and runs the risk score.

## Live weather radar (done ✓)

The **Precipitation radar (LIVE)** toggle adds a real-time rain/snow radar
overlay from RainViewer. `/api/weather`
([app/api/weather/route.js](app/api/weather/route.js)) resolves the latest radar
frame at runtime (the frame path rotates), and the layer sits under the hazard
polygons so both are readable.

## Per-layer timelines (done ✓)

Each time-aware layer has its **own independent timeline** — a play button +
scrubber that appears inline under the layer when it's enabled. They run
simultaneously: you can loop the radar while earthquakes sit parked in 1994 and
snow holds at today.

- **🌍 Quakes** — defaults to the **last 12 months**; a *"from year"* input lets
  you set the window start (e.g. 2000 → today), with a "12 mo" reset. Quakes
  accumulate across the window as the slider advances (filter on `time`).
- **❄️ Snow** — 12 monthly steps; swaps the NASA GIBS tile date so you watch
  snow advance and melt.
- **🌧️ Radar** — loops RainViewer's last ~2 hours of frames.

Implemented in [components/HazardMap.jsx](components/HazardMap.jsx): per-layer
state lives in the `tl` object (`{quakes,snow,radar}` → `{step,max,playing}`),
`applyFor(layer, step)` updates the map, one effect drives all playing loops.

## Roadmap ideas
- **Sea-level rise** — Kartverket "Se havnivå" for coastal flooding.
- **Climate projections** — met.no Frost API for future precipitation/extremes.
