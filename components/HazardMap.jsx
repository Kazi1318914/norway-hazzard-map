"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { HAZARD_LAYERS, BASEMAPS, INITIAL_VIEW, SEA_DEFAULT, SEA_GROUPS, seaScenario, seaTiles } from "../lib/layers";

const WEATHER_BEFORE = HAZARD_LAYERS[0]?.id; // overlays sit under hazard polygons
const QUAKE_STEPS = 200;
const SPEED = { quakes: 45, snow: 700, radar: 450 }; // ms per timeline tick

function gibsSnowUrl(date) {
  const d = date || new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_NDSI_Snow_Cover/default/${d}/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png`;
}

// 12 ~monthly dates (oldest → newest) for the snow timeline.
function snowDates() {
  const out = [];
  const now = Date.now();
  for (let i = 11; i >= 0; i--) out.push(new Date(now - i * 30 * 86400000 - 3 * 86400000).toISOString().slice(0, 10));
  return out;
}

function buildStyle(basemapKey, visible) {
  const base = BASEMAPS[basemapKey];
  const sources = {
    basemap: { type: "raster", tiles: base.tiles, tileSize: 256, attribution: base.attribution },
  };
  const layers = [{ id: "basemap", type: "raster", source: "basemap" }];
  for (const h of HAZARD_LAYERS) {
    sources[h.id] = { type: "raster", tiles: [h.tiles], tileSize: 512 };
    layers.push({
      id: h.id,
      type: "raster",
      source: h.id,
      paint: { "raster-opacity": 0.75 },
      layout: { visibility: visible[h.id] ? "visible" : "none" },
    });
  }
  return { version: 8, sources, layers };
}

function addRaster(map, id, tiles, { maxzoom, opacity = 0.6, before } = {}) {
  if (!map.getSource(id)) {
    map.addSource(id, { type: "raster", tiles: [tiles], tileSize: 256, ...(maxzoom ? { maxzoom } : {}) });
  }
  if (!map.getLayer(id)) {
    map.addLayer(
      { id, type: "raster", source: id, paint: { "raster-opacity": opacity } },
      before && map.getLayer(before) ? before : undefined
    );
  }
}
function removeLayerSource(map, id) {
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
}

// GeoJSON circle (lng/lat) for the area tool.
function circlePolygon(center, radiusKm, steps = 72) {
  const [lng, lat] = center;
  const dLat = radiusKm / 110.574;
  const dLng = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  const coords = [];
  for (let i = 0; i <= steps; i++) {
    const t = (2 * Math.PI * i) / steps;
    coords.push([lng + dLng * Math.cos(t), lat + dLat * Math.sin(t)]);
  }
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [coords] } };
}

// ---- PDF report helpers (module-level) ----
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function toMerc3857(lng, lat) {
  const R = 6378137;
  return { x: (R * lng * Math.PI) / 180, y: R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) };
}
const PDF_MAP_PX = 768; // must match the /api/mapimage default `size`

/**
 * /api/risk reports hazards under its own ids (flood, landslide, snow, rock),
 * which are NOT the HAZARD_LAYERS ids used for rendering (flood-zones,
 * landslide-zones, …). Only "radon" happens to match. Map across explicitly —
 * comparing the two namespaces directly silently yields no overlays.
 */
const RISK_ID_TO_LAYER = {
  flood: "flood-zones",
  landslide: "landslide-zones",
  snow: "snow-avalanche",
  rock: "rock-avalanche",
  radon: "radon",
  // radon and sea-level happen to use the same id on both sides; listed anyway
  // so the mapping stays exhaustive and a missing entry is obvious.
  "sea-level": "sea-level",
};

/** Query string for the server-side flattened report map. */
function mapImageQuery(lng, lat, halfMeters, overlayIds, ring, pin, sizePx, seaId, geoRing) {
  const p = new URLSearchParams({
    lng: String(lng),
    lat: String(lat),
    half: String(Math.round(halfMeters)),
    size: String(sizePx || PDF_MAP_PX),
  });
  if (overlayIds && overlayIds.length) {
    p.set("overlays", overlayIds.join(","));
    // The surge overlay is scenario-specific, so the report map has to be told
    // which one the verdict was scored against.
    if (overlayIds.includes("sea-level") && seaId) p.set("sea", seaId);
  }
  if (ring) p.set("ring", String(ring));
  // A circle that is NOT centred on this image: detail maps are aimed at the
  // hazard, so the screening circle's edge cuts across them off-centre.
  if (geoRing && isFinite(geoRing.km) && geoRing.km > 0) {
    p.set("ringlng", String(geoRing.lng));
    p.set("ringlat", String(geoRing.lat));
    p.set("ringkm", String(geoRing.km));
  }
  if (pin) p.set("pin", "1");
  return `/api/mapimage?${p.toString()}`;
}

// Per-hazard thumbnail size. Printed 2-up this is ~87 mm wide, so 768 px keeps
// it sharp on paper. It MUST match what detailHalfFor() is given, since the
// allowed extent is derived from the pixel width.
const PDF_DETAIL_PX = 768;

// A "detail" map should be a neighbourhood view. Without this cap an ungated
// layer (landslide, radon) would just reuse the full requested extent — for a
// 50 km circle that's a 115 km-wide map, i.e. wider than the circle itself and
// not a detail of anything.
const DETAIL_MAX_KM = 20;

/**
 * Half-extent (web-mercator metres) for a detail thumbnail of `layer`.
 * Two constraints:
 *  1. NVE suppresses several hazard sublayers above a scale threshold, so too
 *     wide an extent silently returns an empty PNG — zoom in past that gate.
 *  2. Cap the ground width so all detail maps stay comparable in scale.
 */
function detailHalfFor(layer, sizePx, requestedHalf, lat) {
  let half = requestedHalf;
  if (layer && layer.maxScale) {
    const maxMetresPerPx = (layer.maxScale * 0.0254) / 96; // ArcGIS scale -> m/px at 96dpi
    half = Math.min(half, ((sizePx * maxMetresPerPx) / 2) * 0.92); // 8% margin below the gate
  }
  if (isFinite(lat)) {
    const capMerc = (DETAIL_MAX_KM * 1000) / 2 / Math.cos((lat * Math.PI) / 180);
    half = Math.min(half, capMerc);
  }
  return half;
}

/** Ground distance in km. Flat approximation, plenty at the 50 km maximum radius. */
function apartKm(lng1, lat1, lng2, lat2) {
  const kx = 111.32 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot((lng2 - lng1) * kx, (lat2 - lat1) * 110.57);
}

/** Ground width of a mercator half-extent, in km (mercator metres shrink by cos(lat)). */
function groundWidthKm(halfMerc, lat) {
  return (2 * halfMerc * Math.cos((lat * Math.PI) / 180)) / 1000;
}

/** "22 Aug 2026 at 17:28" — readable, and unambiguous about day vs month. */
function reportStamp(d = new Date()) {
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${date} at ${time}`;
}

/** "1 zone" / "3 zones" — avoids the robotic "zone(s)". */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Readable location for a report header: "Fretheim, Aurland". Adds the
 * municipality when it differs from the place name, and degrades to just the
 * municipality, or to nothing, when the name lookup comes back empty.
 */
function areaWhere(place) {
  if (!place) return "an unnamed location";
  const parts = [];
  if (place.name) parts.push(place.name);
  if (place.municipality && place.municipality !== place.name) parts.push(place.municipality);
  return parts.length ? parts.join(", ") : "an unnamed location";
}

/** Nearest meaningful place name, or null. Never throws. */
async function fetchPlaceName(lng, lat) {
  try {
    const res = await fetch(`/api/placename?lng=${lng}&lat=${lat}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const d = await res.json();
    // Keep the result when only the municipality resolved — "Aurland" alone is
    // still a better header than a pair of coordinates.
    return d && (d.name || d.municipality) ? d : null;
  } catch {
    return null;
  }
}

/**
 * Human-readable "where is this" phrase for a detail-map caption. Prefers a
 * place name, but keeps the distance visible when the name is not right at the
 * point — a label 2 km away must not read as the exact spot. Returns the whole
 * phrase (including the preposition) so the wording stays grammatical. Falls
 * back to coordinates when no name resolves.
 */
function placeLabel(place, lng, lat) {
  if (!place) return `at ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  if (place.distanceM >= 1200) return `${(place.distanceM / 1000).toFixed(1)} km from ${place.name}`;
  return `near ${place.name}`;
}

/**
 * One detail map per hazard that is actually present. `items` are
 * { layerId, label, centre:[lng,lat], half, noteFor(whereLabel) }.
 */
async function buildDetailMaps(items, seaId, geoRing) {
  const results = await Promise.all(
    items.map(async (it) => {
      const url = mapImageQuery(it.centre[0], it.centre[1], it.half, [it.layerId], null, true, PDF_DETAIL_PX, seaId, geoRing);
      const [dataUrl, place] = await Promise.all([
        fetchMapDataUrl(url),
        it.needsPlace ? fetchPlaceName(it.centre[0], it.centre[1]) : Promise.resolve(null),
      ]);
      if (!dataUrl) return null;
      const note = it.noteFor ? it.noteFor(placeLabel(place, it.centre[0], it.centre[1])) : it.note;
      return { ...it, dataUrl, note };
    })
  );
  const ok = results.filter(Boolean);
  if (!ok.length) return "";
  const figs = ok
    .map(
      (r) =>
        `<figure class="dfig">` +
        `<img width="${PDF_DETAIL_PX}" height="${PDF_DETAIL_PX}" src="${r.dataUrl}" alt="${esc(r.label)} detail"/>` +
        `<figcaption><b>${esc(r.label)}</b><br>${esc(r.note)}</figcaption>` +
        `</figure>`
    )
    .join("");
  return `<section class="detail-page"><h2>Hazard detail maps</h2><div class="dgrid">${figs}</div></section>`;
}

/** Fetch the composite and inline it as a data: URI. Returns null on any failure. */
async function fetchMapDataUrl(query) {
  try {
    const res = await fetch(query, { signal: AbortSignal.timeout(45000) });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(typeof fr.result === "string" ? fr.result : null);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * The good path: ONE flat opaque bitmap, sized by width/height attributes so the
 * intrinsic ratio resolves without `aspect-ratio`, and with no positioning,
 * transparency or stacking for the print rasterizer to get wrong.
 */
function flatMapHtml(dataUrl) {
  return `<div class="mapwrap"><img class="flat" width="${PDF_MAP_PX}" height="${PDF_MAP_PX}" src="${dataUrl}" alt="map"/></div>`;
}

/**
 * Degraded path, used only when the composite endpoint is unreachable: the old
 * cross-origin stack, but hardened. The translucent + transformed + rounded
 * `.circ` div is gone (that combination is what Chrome's print rasterizer
 * composited without its backdrop, painting a white disc over the map); decor
 * is now a stroke-only SVG with no fill and no transform.
 */
function pdfMapImageFallback(lng, lat, halfMeters, overlayIds, decor) {
  const m = toMerc3857(lng, lat);
  const bbox = `${m.x - halfMeters},${m.y - halfMeters},${m.x + halfMeters},${m.y + halfMeters}`;
  const base = `https://wms.geonorge.no/skwms1/wms.topograatone?service=WMS&version=1.3.0&request=GetMap&layers=topograatone&styles=&crs=EPSG:3857&bbox=${bbox}&width=640&height=640&format=image/png`;
  const overlays = (overlayIds || [])
    .map((id) => {
      const lyr = HAZARD_LAYERS.find((h) => h.id === id);
      return lyr
        ? `<img class="ov" width="640" height="640" src="${esc(lyr.tiles.replace("{bbox-epsg-3857}", bbox))}" alt=""/>`
        : "";
    })
    .join("");
  const rPct = decor && decor.circleFrac ? (decor.circleFrac * 50).toFixed(2) : null;
  const svg =
    `<svg class="dec" viewBox="0 0 100 100" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">` +
    (rPct ? `<circle cx="50" cy="50" r="${rPct}" fill="none" stroke="#2563eb" stroke-width="0.5" stroke-dasharray="2 1"/>` : "") +
    `<circle cx="50" cy="50" r="1.6" fill="#dc2626" stroke="#ffffff" stroke-width="0.6"/>` +
    `</svg>`;
  return `<div class="mapwrap stack"><img class="base" width="640" height="640" src="${esc(base)}" alt="map"/>${overlays}${svg}</div>`;
}
const REPORT_CSS = `
/* Scenario meanings, so a printed report explains its own jargon. */
td .note{display:block;margin-top:2px;font-size:.78em;color:#6b7280;line-height:1.35}
  *{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{font:13px/1.5 -apple-system,system-ui,"Segoe UI",Roboto,sans-serif;color:#111827;max-width:760px;margin:0 auto;padding:0 22px 28px}
  .band{background:#0b3d6b;color:#fff;margin:0 -22px 16px;padding:20px 22px}
  .band h1{margin:0;font-size:21px} .band p{margin:3px 0 0;opacity:.85;font-size:13px}
  .meta{color:#6b7280;font-size:12px;margin:0 0 14px}
  h2{font-size:14px;margin:22px 0 8px;border-bottom:2px solid #e5e7eb;padding-bottom:4px}
  .verdict{font-size:16px;font-weight:700;margin:6px 0 10px}
  .verdict.bad{color:#b91c1c} .verdict.ok{color:#15803d}
  /* Safety net: a hazard table must move whole rather than orphan one row. */
  table{border-collapse:collapse;width:100%;break-inside:avoid;page-break-inside:avoid}
  td{border-bottom:1px solid #eee;padding:7px 6px;vertical-align:top;font-size:12.5px}
  td.ic{width:20px} td.ic.hit{color:#b91c1c} td.ic.ok{color:#15803d}
  td.lab{font-weight:600;white-space:nowrap}
  ul{margin:6px 0;padding-left:18px} li{margin:2px 0;font-size:12.5px}
  .src{font-size:12px;line-height:1.5;color:#374151;margin:6px 0 0;max-width:60em}
  .pill{display:inline-block;font-size:11px;font-weight:700;padding:1px 7px;border-radius:99px;text-transform:capitalize}
  .lvl-green{background:#dcfce7;color:#166534}.lvl-yellow{background:#fef9c3;color:#854d0e}.lvl-orange{background:#ffedd5;color:#9a3412}.lvl-red{background:#fee2e2;color:#b91c1c}
  /* Flat path: a single in-flow bitmap. No position, no aspect-ratio, no
     overflow clip, no stacking context — nothing for the print rasterizer to
     composite incorrectly. width/height attrs on the <img> supply the ratio. */
  /* Capped in mm, not px: at 760px body width the map would print ~188mm tall
     and push the hazard table onto its own page, orphaning a single row. */
  .mapwrap{margin:0 auto 4px;max-width:150mm;break-inside:avoid;page-break-inside:avoid}
  .mapwrap img.flat{display:block;width:100%;height:auto;border:1px solid #d1d5db}
  /* Degraded path only (pdfMapImageFallback). */
  .mapwrap.stack{position:relative;width:100%;aspect-ratio:1/1;border:1px solid #d1d5db;overflow:hidden;background:#eef2f7}
  .mapwrap.stack img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
  .mapwrap.stack .ov{opacity:.75}
  .mapwrap.stack .dec{position:absolute;inset:0;width:100%;height:100%}
  /* Per-hazard detail maps: their own page(s), 2-up, each figure kept whole so
     a row that doesn't fit moves to the next page instead of being sliced. */
  .detail-page{break-before:page;page-break-before:always}
  .dgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:8px}
  .dfig{margin:0;break-inside:avoid;page-break-inside:avoid}
  .dfig img{display:block;width:100%;height:auto;border:1px solid #d1d5db}
  .dfig figcaption{font-size:11px;line-height:1.35;color:#4b5563;margin-top:4px}
  /* Context + sources + disclaimer: start a fresh page and stay together. */
  .tail-page{break-before:page;page-break-before:always}
  .tail-page ul,.tail-page h2{break-inside:avoid;page-break-inside:avoid}
  .foot{margin-top:20px;border-top:1px solid #ddd;padding-top:10px;color:#6b7280;font-size:11px;break-inside:avoid;page-break-inside:avoid}
  a{color:#2563eb;text-decoration:none}
  h2{break-after:avoid}
  @page{margin:14mm}
  @media print{.band{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
`;
// Written as prose rather than a bolded label-and-value list: the list form
// reads like generated filler, and these five lines are short enough to say
// plainly.
const SOURCES_HTML = `<p class="src">
  Flood zones, landslide and quick-clay zones, avalanche zones and the daily
  warnings all come from NVE (<a href="https://www.nve.no">nve.no</a> and Varsom).
  Radon classes come from NGU (<a href="https://www.ngu.no">ngu.no</a>).
  Earthquake records come from the USGS (<a href="https://earthquake.usgs.gov">earthquake.usgs.gov</a>).
  Temperature, wind and rainfall come from Open-Meteo (<a href="https://open-meteo.com">open-meteo.com</a>).
  The base map, addresses and place names come from Kartverket, and the fallback
  base map uses OpenStreetMap data.
</p>`;
/**
 * The report is rendered into an on-page iframe rather than a popup window.
 *
 * window.open() was the obvious approach and it was the wrong one. Pop-up
 * blockers kill it, Chrome's transient user activation expires about 5 seconds
 * after the click so a slow map composite loses the right to open a window at
 * all, and embedded browsers refuse it outright. An iframe needs no permission,
 * cannot be blocked, and prints the same: the report's own script calls
 * window.print() inside the frame, so the dialog covers the frame's document and
 * not the app around it.
 */
/**
 * `tailHtml` (context) plus sources and the disclaimer are grouped into one
 * block. When detail maps are present that block starts a new page, so the
 * sources list can't end up split with a single orphaned bullet on the last
 * page. Without detail maps it flows normally rather than wasting a page.
 */
function buildReportHtml({ title, subtitle, locLine, mapHtml, bodyHtml, tailHtml, tailOnNewPage }) {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${REPORT_CSS}</style></head><body>` +
    `<div class="band"><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>` +
    `<p class="meta">${locLine}</p>${mapHtml}${bodyHtml}` +
    `<section class="${tailOnNewPage ? "tail-page" : ""}">` +
    `${tailHtml || ""}` +
    `<h2>Data sources</h2>${SOURCES_HTML}` +
    `<p class="foot">This is a screening report. It does not replace a geotechnical assessment by a qualified engineer. Generated by the Norway Hazard Map.</p>` +
    `</section>` +
    `<script>
      var done=false;
      function go(){ if(done) return; done=true; try{ window.focus(); window.print(); }catch(e){} }
      function imagesReady(){
        var imgs=[].slice.call(document.images);
        return Promise.all(imgs.map(function(im){
          if(im.complete && im.naturalWidth>0) return Promise.resolve();
          return new Promise(function(res){ im.addEventListener('load',res); im.addEventListener('error',res); });
        }));
      }
      // Print only once every image has actually finished loading (slow tiles/VPN).
      imagesReady().then(function(){ setTimeout(go, 350); });
      setTimeout(go, 20000); // safety cap if an image hangs
    </script>` +
    `</body></html>`
  );
}

const EMPTY_TL = { step: 0, max: 0, playing: false };

export default function HazardMap() {
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const didInitBasemap = useRef(false);
  const weatherUrlRef = useRef(null);
  const radarFramesRef = useRef(null);
  const quakeDataRef = useRef(null);
  const quakeRangeRef = useRef(null);
  const quakeEndRef = useRef(Date.now()); // window end = "now"
  const quakeStartRef = useRef(Date.now() - 365 * 86400000); // mirrors quakeStartMs for scoreLocation
  const snowDatesRef = useRef(null);
  const searchTimer = useRef(null);

  const [basemap, setBasemap] = useState("kartverket");
  const [visible, setVisible] = useState(() =>
    Object.fromEntries(HAZARD_LAYERS.map((h) => [h.id, h.defaultOn]))
  );
  const [weatherOn, setWeatherOn] = useState(false);
  const [snowOn, setSnowOn] = useState(false);
  const [quakesOn, setQuakesOn] = useState(false);
  const [quakeStartMs, setQuakeStartMs] = useState(() => Date.now() - 365 * 86400000); // last 12 months
  const [quakeYear, setQuakeYear] = useState("");
  // Storm surge is scenario-driven rather than time-driven: a return period
  // crossed with a climate year. Held here so the map layer, both API calls and
  // the PDF all score the same scenario.
  const [seaId, setSeaId] = useState(SEA_DEFAULT);
  const seaIdRef = useRef(SEA_DEFAULT);
  const [risk, setRisk] = useState(null);
  const [riskMin, setRiskMin] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  // The built report, shown in an overlay iframe. Null when nothing is open.
  const [report, setReport] = useState(null);
  const reportFrameRef = useRef(null);
  const [pdfErr, setPdfErr] = useState("");
  const [zoom, setZoom] = useState(INITIAL_VIEW.zoom);

  // ---- mode + area tool ----
  const [mode, setMode] = useState("point"); // 'point' | 'area'
  const [areaRadius, setAreaRadius] = useState(25);
  const [area, setArea] = useState(null);
  const [areaMin, setAreaMin] = useState(false);
  const modeRef = useRef("point");
  const areaRadiusRef = useRef(25);
  const areaCenterRef = useRef(null);
  const areaFetchTimer = useRef(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  // Independent per-layer timeline state.
  const [tl, setTl] = useState({ quakes: { ...EMPTY_TL }, snow: { ...EMPTY_TL }, radar: { ...EMPTY_TL } });
  const patchTl = (layer, patch) => setTl((prev) => ({ ...prev, [layer]: { ...prev[layer], ...patch } }));

  // ---- overlay add/remove ----
  function ensureWeather(map) {
    addRaster(map, "weather", weatherUrlRef.current, { maxzoom: 7, opacity: 0.6, before: WEATHER_BEFORE });
  }
  function ensureSnow(map) {
    addRaster(map, "snow", gibsSnowUrl(), { maxzoom: 8, opacity: 0.65, before: WEATHER_BEFORE });
  }
  function ensureQuakes(map) {
    const data = quakeDataRef.current;
    if (!data) return;
    if (!map.getSource("earthquakes")) map.addSource("earthquakes", { type: "geojson", data });
    if (!map.getLayer("earthquakes")) {
      map.addLayer({
        id: "earthquakes",
        type: "circle",
        source: "earthquakes",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["get", "mag"], 2, 3, 4, 9, 6, 22],
          "circle-color": ["interpolate", ["linear"], ["get", "mag"], 2, "#fde047", 4, "#f97316", 5.5, "#dc2626"],
          "circle-opacity": 0.75,
          "circle-stroke-color": "#7f1d1d",
          "circle-stroke-width": 1,
        },
      });
    }
  }

  // The surge scenario lives in a raster source, so switching it is a setTiles
  // swap rather than a style rebuild. buildStyle() only knows the default, so
  // this has to run again after every setStyle (basemap change) too.
  function applySeaScenario(map, id) {
    const src = map && map.getSource("sea-level");
    if (src && src.setTiles) src.setTiles([seaTiles(id)]);
  }

  function onSeaChange(id) {
    setSeaId(id);
    seaIdRef.current = id;
    applySeaScenario(mapRef.current, id);
    // Any open verdict was scored against the old scenario, so re-score it.
    if (mode === "point" && risk && !risk.outside && isFinite(risk.lng)) scoreLocation(risk.lng, risk.lat, false);
    if (mode === "area" && areaCenterRef.current) fetchArea(areaCenterRef.current, areaRadiusRef.current);
  }

  // Re-apply active overlays (and their current timeline step) after a setStyle.
  function reapplyOverlays(map) {
    if (seaIdRef.current !== SEA_DEFAULT) applySeaScenario(map, seaIdRef.current);
    if (weatherOn) { ensureWeather(map); applyFor("radar", tl.radar.step); }
    if (snowOn) { ensureSnow(map); applyFor("snow", tl.snow.step); }
    if (quakesOn) { ensureQuakes(map); applyFor("quakes", tl.quakes.step); }
    if (areaCenterRef.current) drawCircle(areaCenterRef.current, areaRadiusRef.current);
  }

  // ---- data loaders ----
  async function loadWeather() {
    if (radarFramesRef.current) return;
    try {
      const d = await (await fetch("/api/weather")).json();
      weatherUrlRef.current = d.tileUrl || null;
      radarFramesRef.current = d.frames || [];
    } catch {
      radarFramesRef.current = [];
    }
  }
  async function loadQuakes() {
    if (quakeDataRef.current) return;
    try {
      const data = await (await fetch("/api/earthquakes")).json();
      quakeDataRef.current = data;
      const times = (data.features || []).map((f) => f.properties.time).filter(Boolean);
      if (times.length) quakeRangeRef.current = { min: Math.min(...times), max: Math.max(...times) };
    } catch {
      quakeDataRef.current = { type: "FeatureCollection", features: [] };
    }
  }

  // ---- timeline apply + labels (per layer) ----
  function applyFor(layer, step) {
    const map = mapRef.current;
    if (!map) return;
    if (layer === "quakes") {
      if (!map.getLayer("earthquakes")) return;
      const start = quakeStartMs;
      const end = quakeEndRef.current;
      const t = start + (step / QUAKE_STEPS) * (end - start);
      map.setFilter("earthquakes", ["all", [">=", ["get", "time"], start], ["<=", ["get", "time"], t]]);
    } else if (layer === "snow") {
      const dates = snowDatesRef.current;
      const src = map.getSource("snow");
      if (dates && src && src.setTiles) src.setTiles([gibsSnowUrl(dates[Math.min(step, dates.length - 1)])]);
    } else if (layer === "radar") {
      const frames = radarFramesRef.current;
      const src = map.getSource("weather");
      if (frames && frames.length && src && src.setTiles)
        src.setTiles([frames[Math.min(step, frames.length - 1)].tileUrl]);
    }
  }
  function labelFor(layer, step) {
    if (layer === "quakes") {
      const start = quakeStartMs;
      const end = quakeEndRef.current;
      const d = new Date(start + (step / QUAKE_STEPS) * (end - start));
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    }
    if (layer === "snow") {
      const dates = snowDatesRef.current;
      return dates ? dates[Math.min(step, dates.length - 1)] : "";
    }
    if (layer === "radar") {
      const frames = radarFramesRef.current;
      const f = frames && frames[Math.min(step, frames.length - 1)];
      if (!f) return "";
      return new Date(f.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return "";
  }

  function setStepFor(layer, v) {
    setTl((prev) => ({ ...prev, [layer]: { ...prev[layer], step: v, playing: false } }));
  }
  function playLayer(layer) {
    setTl((prev) => {
      const c = prev[layer];
      const np = !c.playing;
      return { ...prev, [layer]: { ...c, playing: np, step: np && c.step >= c.max ? 0 : c.step } };
    });
  }

  // Earthquake window: set the start to Jan 1 of a typed year (clamped to the
  // 1990–present data range), or reset to the last 12 months.
  function applyQuakeYear() {
    const y = parseInt(quakeYear, 10);
    const nowY = new Date().getFullYear();
    if (!y || y < 1990 || y > nowY) return;
    setQuakeStartMs(Date.UTC(y, 0, 1));
    patchTl("quakes", { step: QUAKE_STEPS, playing: false });
  }
  function resetQuakeWindow() {
    setQuakeYear("");
    setQuakeStartMs(Date.now() - 365 * 86400000);
    patchTl("quakes", { step: QUAKE_STEPS, playing: false });
  }

  // Apply each layer's current step (and on enable).
  useEffect(() => { quakeStartRef.current = quakeStartMs; }, [quakeStartMs]);
  useEffect(() => { if (quakesOn) applyFor("quakes", tl.quakes.step); /* eslint-disable-next-line */ }, [tl.quakes.step, quakesOn, quakeStartMs]);
  useEffect(() => { if (snowOn) applyFor("snow", tl.snow.step); /* eslint-disable-next-line */ }, [tl.snow.step, snowOn]);
  useEffect(() => { if (weatherOn) applyFor("radar", tl.radar.step); /* eslint-disable-next-line */ }, [tl.radar.step, weatherOn]);

  // One play loop managing all independently-playing timelines.
  useEffect(() => {
    const ids = [];
    for (const layer of ["quakes", "snow", "radar"]) {
      if (tl[layer].playing) {
        ids.push(
          setInterval(() => {
            setTl((prev) => {
              const c = prev[layer];
              return { ...prev, [layer]: { ...c, step: c.step >= c.max ? 0 : c.step + 1 } };
            });
          }, SPEED[layer])
        );
      }
    }
    return () => ids.forEach(clearInterval);
  }, [tl.quakes.playing, tl.snow.playing, tl.radar.playing]);

  // ---- shared point scoring ----
  const scoreLocation = useCallback(async (lng, lat, fly) => {
    const map = mapRef.current;
    if (!map) return;
    if (fly) map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 13), duration: 1200 });
    if (!markerRef.current) markerRef.current = new maplibregl.Marker({ color: "#dc2626" });
    markerRef.current.setLngLat([lng, lat]).addTo(map);
    setRiskMin(false);
    setRisk({ loading: true, lng, lat });
    try {
      const res = await fetch(`/api/risk?lng=${lng}&lat=${lat}&from=${quakeStartRef.current}&sea=${seaIdRef.current}`);
      setRisk({ ...(await res.json()), loading: false });
    } catch {
      setRisk({ error: true, loading: false });
    }
  }, []);

  // ---- area tool ----
  function drawCircle(center, radiusKm) {
    const map = mapRef.current;
    if (!map) return;
    const f = circlePolygon(center, radiusKm);
    if (map.getSource("area-circle")) {
      map.getSource("area-circle").setData(f);
    } else {
      map.addSource("area-circle", { type: "geojson", data: f });
      map.addLayer({ id: "area-fill", type: "fill", source: "area-circle", paint: { "fill-color": "#2563eb", "fill-opacity": 0.08 } });
      map.addLayer({ id: "area-line", type: "line", source: "area-circle", paint: { "line-color": "#2563eb", "line-width": 2, "line-dasharray": [2, 1] } });
    }
  }
  function clearCircle() {
    const map = mapRef.current;
    if (!map) return;
    ["area-fill", "area-line"].forEach((id) => map.getLayer(id) && map.removeLayer(id));
    if (map.getSource("area-circle")) map.removeSource("area-circle");
  }
  const fetchArea = useCallback(async (center, radius) => {
    setArea({ loading: true, radius });
    try {
      const d = await (
        await fetch(`/api/area?lng=${center[0]}&lat=${center[1]}&radius=${radius}&from=${quakeStartRef.current}&sea=${seaIdRef.current}`)
      ).json();
      setArea({ ...d, loading: false });
    } catch {
      setArea({ error: true, loading: false });
    }
  }, []);

  // Frame the whole circle in view (zoom out if needed).
  function fitCircle(center, radiusKm) {
    const map = mapRef.current;
    if (!map) return;
    const [lng, lat] = center;
    const dLat = radiusKm / 110.574;
    const dLng = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
    map.fitBounds(
      [
        [lng - dLng, lat - dLat],
        [lng + dLng, lat + dLat],
      ],
      { padding: 60, maxZoom: 14, duration: 700 }
    );
  }

  // ---- init map once ----
  useEffect(() => {
    if (mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: buildStyle(basemap, visible),
      center: INITIAL_VIEW.center,
      zoom: INITIAL_VIEW.zoom,
      minZoom: INITIAL_VIEW.minZoom,
      maxZoom: INITIAL_VIEW.maxZoom,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    map.on("error", (e) => console.warn("[map error]", e?.error?.message || e?.error || e));
    map.on("load", () => map.resize());
    map.on("zoomend", () => setZoom(map.getZoom()));
    map.on("click", (e) => {
      if (modeRef.current === "area") {
        const c = [e.lngLat.lng, e.lngLat.lat];
        areaCenterRef.current = c;
        setAreaMin(false);
        drawCircle(c, areaRadiusRef.current);
        fitCircle(c, areaRadiusRef.current);
        fetchArea(c, areaRadiusRef.current);
      } else {
        scoreLocation(e.lngLat.lng, e.lngLat.lat, false);
      }
    });
    map.getCanvas().style.cursor = "crosshair";

    const quakePopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "quake-popup" });
    map.on("mouseenter", "earthquakes", (e) => {
      map.getCanvas().style.cursor = "pointer";
      const f = e.features[0];
      const p = f.properties;
      const date = new Date(p.time).toISOString().slice(0, 10);
      quakePopup.setLngLat(f.geometry.coordinates).setHTML(`<b>M ${p.mag}</b><br>${p.place || "—"}<br>${date}`).addTo(map);
    });
    map.on("mouseleave", "earthquakes", () => {
      map.getCanvas().style.cursor = "crosshair";
      quakePopup.remove();
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- basemap swap ----
  useEffect(() => {
    if (!didInitBasemap.current) {
      didInitBasemap.current = true;
      return;
    }
    const map = mapRef.current;
    if (!map) return;
    map.setStyle(buildStyle(basemap, visible));
    map.once("styledata", () => reapplyOverlays(map));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemap]);

  function toggleHazard(id) {
    setVisible((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      const map = mapRef.current;
      if (map && map.getLayer(id)) map.setLayoutProperty(id, "visibility", next[id] ? "visible" : "none");
      return next;
    });
  }

  async function toggleWeather() {
    const map = mapRef.current;
    if (!map) return;
    const next = !weatherOn;
    setWeatherOn(next);
    if (next) {
      await loadWeather();
      ensureWeather(map);
      const max = Math.max(0, (radarFramesRef.current?.length || 1) - 1);
      patchTl("radar", { max, step: max, playing: false });
    } else {
      patchTl("radar", { playing: false });
      removeLayerSource(map, "weather");
    }
  }
  function toggleSnow() {
    const map = mapRef.current;
    if (!map) return;
    const next = !snowOn;
    setSnowOn(next);
    if (next) {
      if (!snowDatesRef.current) snowDatesRef.current = snowDates();
      ensureSnow(map);
      const max = snowDatesRef.current.length - 1;
      patchTl("snow", { max, step: max, playing: false });
    } else {
      patchTl("snow", { playing: false });
      removeLayerSource(map, "snow");
    }
  }
  async function toggleQuakes() {
    const map = mapRef.current;
    if (!map) return;
    const next = !quakesOn;
    setQuakesOn(next);
    if (next) {
      quakeEndRef.current = Date.now();
      await loadQuakes();
      ensureQuakes(map);
      patchTl("quakes", { max: QUAKE_STEPS, step: QUAKE_STEPS, playing: false });
    } else {
      patchTl("quakes", { playing: false });
      removeLayerSource(map, "earthquakes");
    }
  }

  // ---- address search ----
  function onQueryChange(e) {
    const v = e.target.value;
    setQuery(v);
    clearTimeout(searchTimer.current);
    if (v.trim().length < 3) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const d = await (await fetch(`/api/geocode?q=${encodeURIComponent(v)}`)).json();
        setResults(d.results || []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  }
  function selectResult(r) {
    setQuery(`${r.text}, ${r.place}`);
    setResults([]);
    scoreLocation(r.lon, r.lat, true);
  }
  function closeRisk() {
    setRisk(null);
    setPdfErr("");
    if (markerRef.current) markerRef.current.remove();
  }

  function selectMode(m) {
    modeRef.current = m;
    setMode(m);
    if (m === "area") {
      closeRisk(); // hide the point card when switching to area
    } else {
      clearCircle();
      setArea(null);
      areaCenterRef.current = null;
    }
  }
  function onRadiusChange(v) {
    areaRadiusRef.current = v;
    setAreaRadius(v);
    if (areaCenterRef.current) {
      drawCircle(areaCenterRef.current, v);
      fitCircle(areaCenterRef.current, v);
      clearTimeout(areaFetchTimer.current);
      areaFetchTimer.current = setTimeout(() => fetchArea(areaCenterRef.current, v), 350);
    }
  }
  function closeArea() {
    setArea(null);
    setPdfErr("");
    clearCircle();
    areaCenterRef.current = null;
  }

  function showReport(title, html) {
    setReport({ title, html });
  }

  /**
   * Print the iframe's document, not the page. The report's own script fires
   * this once its images have loaded, so the button is for printing again after
   * dismissing the dialog.
   */
  function printReport() {
    const f = reportFrameRef.current;
    if (!f || !f.contentWindow) return;
    f.contentWindow.focus();
    f.contentWindow.print();
  }

  // Rich PDF for the point report.
  async function exportPdf() {
    if (!risk || risk.loading || risk.error || risk.outside || pdfBusy) return;
    setPdfBusy(true);
    setPdfErr("");
    try {
      // Prefer the address the user typed; if they clicked the map instead,
      // name the place rather than printing coordinates.
      const sitePlace = query ? null : await fetchPlaceName(risk.lng, risk.lat);
      const loc = query ? esc(query) : esc(areaWhere(sitePlace));
      // Only draw overlays for hazards actually present, so a clean site never
      // gets a hazard overlay under a "No mapped hazards" verdict.
      const present = risk.hazards
        .filter((h) => h.inZone)
        .map((h) => RISK_ID_TO_LAYER[h.id])
        .filter((id) => id && HAZARD_LAYERS.some((l) => l.id === id));
      // Latitude-correct the half-extent so 6 km means 6 km on the ground
      // (web-mercator metres shrink by cos(lat)).
      const halfPoint = 6000 / Math.cos((risk.lat * Math.PI) / 180);
      // Overview map + one detail map per hazard actually present, in parallel.
      const detailItems = present.map((id) => {
        const lyr = HAZARD_LAYERS.find((l) => l.id === id);
        const half = detailHalfFor(lyr, PDF_DETAIL_PX, halfPoint, risk.lat);
        return {
          layerId: id,
          label: lyr.label,
          centre: [risk.lng, risk.lat],
          half,
          note: `About ${groundWidthKm(half, risk.lat).toFixed(1)} km across, centred on the site.`,
        };
      });
      const [dataUrl, detailHtml] = await Promise.all([
        fetchMapDataUrl(mapImageQuery(risk.lng, risk.lat, halfPoint, present, null, true, PDF_MAP_PX, seaIdRef.current)),
        buildDetailMaps(detailItems, seaIdRef.current),
      ]);
      let mapHtml;
      if (dataUrl) {
        mapHtml = flatMapHtml(dataUrl);
      } else {
        mapHtml = pdfMapImageFallback(risk.lng, risk.lat, halfPoint, present, "pin");
        setPdfErr("Map composite unavailable — used a basic map.");
      }
      const hazRows = risk.hazards
        .map(
          (h) =>
            `<tr><td class="ic ${h.inZone ? "hit" : "ok"}">${h.inZone ? "&#9888;" : "&#10003;"}</td><td class="lab">${esc(h.label)}</td><td>${esc(h.detail)}` +
            `${h.note ? `<span class="note">${esc(h.note)}</span>` : ""}</td></tr>`
        )
        .join("");
      const w = risk.warnings;
      const warnHtml =
        w && (w.flood || w.landslide)
          ? `<h2>Today's warnings for ${esc(w.county)}</h2><p>Flood <span class="pill lvl-${esc(w.flood)}">${esc(w.flood || "n/a")}</span> &nbsp; Landslide <span class="pill lvl-${esc(w.landslide)}">${esc(w.landslide || "n/a")}</span></p>`
          : "";
      const c = risk.context || {};
      const ctx = [
        c.weather
          ? `<li>Weather ${c.weather.observedAt ? `recorded ${esc(c.weather.observedAt)}` : "right now"}: ${esc(c.weather.text)}</li>`
          : "",
        c.climate ? `<li>Rainfall over the past year: ${esc(c.climate)}</li>` : "",
        c.quakes ? `<li>Earthquakes nearby: ${esc(c.quakes)}</li>` : "",
      ].join("");
      const verdict =
        risk.overall === "at-risk"
          ? `<div class="verdict bad">&#9888; This site falls inside ${risk.hitCount} mapped hazard zone${risk.hitCount > 1 ? "s" : ""}</div>`
          : `<div class="verdict ok">&#10003; No mapped hazard zone covers this site</div>`;
      showReport(
        "Site report",
        buildReportHtml({
          title: "Norway Hazard Map: Site Report",
          subtitle: "Natural hazard screening for one property",
          locLine: `Site: <b>${loc}</b> (${risk.lat.toFixed(5)}, ${risk.lng.toFixed(5)}). Prepared ${esc(reportStamp())}.`,
          mapHtml,
          bodyHtml: `${verdict}<h2>Hazard zones</h2><table>${hazRows}</table>${warnHtml}${detailHtml}`,
          tailHtml: ctx ? `<h2>Conditions and history</h2><ul>${ctx}</ul>` : "",
          tailOnNewPage: !!detailHtml,
        })
      );
    } finally {
      setPdfBusy(false);
    }
  }

  // Rich PDF for the area report.
  async function exportAreaPdf() {
    if (!area || area.loading || area.error || area.outside || pdfBusy) return;
    setPdfBusy(true);
    setPdfErr("");
    try {
      const center = areaCenterRef.current || [area.lng, area.lat];
      // 15% padding around the circle, undone by the ring fraction below.
      const halfM = (area.radius * 1000 * 1.15) / Math.cos((center[1] * Math.PI) / 180);
      // No NVE overlays on the area map: at 25–50 km the hazard layers are
      // scale-suppressed (blank) or render coarse survey-area boxes.
      // A 25–50 km circle is far above NVE's render-scale gate, so a
      // full-circle hazard map would come back blank. Instead aim each detail
      // map at where that hazard actually is (focus from /api/area) and say so.
      const detailItems = (area.hazards || [])
        .filter((h) => h.present)
        .map((h) => {
          const layerId = RISK_ID_TO_LAYER[h.id];
          const lyr = HAZARD_LAYERS.find((l) => l.id === layerId);
          if (!lyr) return null;
          const centre = h.focus ? [h.focus.lng, h.focus.lat] : center;
          const half = detailHalfFor(lyr, PDF_DETAIL_PX, halfM, centre[1]);
          const spanKm = groundWidthKm(half, centre[1]);
          const span = spanKm.toFixed(1);
          // Does the circle's edge actually cross this close-up? The frame is
          // aimed at the hazard, so the edge is off-centre and often outside the
          // frame entirely. Saying which it is stops the missing dashed line from
          // reading as a bug.
          const offCentreKm = apartKm(center[0], center[1], centre[0], centre[1]);
          const cornerKm = (spanKm / 2) * Math.SQRT2;
          const edgeShows = offCentreKm + cornerKm > area.radius;
          const circleBit = edgeShows
            ? ` The dashed line is the edge of the ${area.radius} km circle.`
            : ` All of this view is inside the ${area.radius} km circle.`;
          return {
            layerId,
            label: lyr.label,
            centre,
            half,
            needsPlace: !!h.focus, // resolve a place name for the caption
            noteFor: (where) =>
              (h.focus
                ? `About ${span} km across, ${where}. This is a close-up, not the whole circle.`
                : `About ${span} km across, at the centre of the circle. This is a close-up, not the whole circle.`) +
              circleBit,
          };
        })
        .filter(Boolean);
      const [dataUrl, detailHtml, centrePlace] = await Promise.all([
        fetchMapDataUrl(mapImageQuery(center[0], center[1], halfM, [], 1 / 1.15, true)),
        buildDetailMaps(detailItems, seaIdRef.current, { lng: center[0], lat: center[1], km: area.radius }),
        fetchPlaceName(center[0], center[1]),
      ]);
      let mapHtml;
      if (dataUrl) {
        mapHtml = flatMapHtml(dataUrl);
      } else {
        mapHtml = pdfMapImageFallback(center[0], center[1], halfM, [], { circleFrac: 1 / 1.15 });
        setPdfErr("Map composite unavailable — used a basic map.");
      }
      const rows = (area.hazards || [])
        .map((h) => {
          const say =
            h.present === null
              ? "Could not be checked."
              : h.present
              ? `${plural(h.count, "mapped zone")} overlap this area.`
              : "Nothing mapped in this area.";
          return (
            `<tr><td class="ic ${h.present ? "hit" : "ok"}">${h.present ? "&#9888;" : "&#10003;"}</td>` +
            `<td class="lab">${esc(h.label)}</td><td>${say}` +
            `${h.note ? `<span class="note">${esc(h.note)}</span>` : ""}</td></tr>`
          );
        })
        .join("");
      const ctx = [
        area.quakes ? `<li>Earthquakes in this area: ${esc(area.quakes.text)}</li>` : "",
        area.radon ? `<li>Radon: ${esc(area.radon.text)}</li>` : "",
      ].join("");
      showReport(
        `Area report, ${area.radius} km`,
        buildReportHtml({
          title: "Norway Hazard Map: Area Report",
          subtitle: `Natural hazard screening within ${area.radius} km`,
          // Lead with the place, not the coordinates. Coordinates stay in
          // brackets so the area is still reproducible.
          locLine:
            `Centred on <b>${esc(areaWhere(centrePlace))}</b> ` +
            `(${center[1].toFixed(5)}, ${center[0].toFixed(5)}), covering everything within ` +
            `${area.radius} km. Prepared ${esc(reportStamp())}.`,
          mapHtml,
          bodyHtml: `<h2>Hazard zones in this area</h2><table>${rows}</table>${detailHtml}`,
          tailHtml: ctx ? `<h2>Conditions and history</h2><ul>${ctx}</ul>` : "",
          tailOnNewPage: !!detailHtml,
        })
      );
    } finally {
      setPdfBusy(false);
    }
  }

  // ---- inline per-layer timeline control ----
  function miniTimeline(layer) {
    const s = tl[layer];
    return (
      <div className="mini-tl">
        <button className="tl-play sm" onClick={() => playLayer(layer)} aria-label={s.playing ? "Pause" : "Play"}>
          {s.playing ? "⏸" : "▶"}
        </button>
        <input type="range" min={0} max={s.max} value={s.step} onChange={(e) => setStepFor(layer, +e.target.value)} />
        <span className="tl-label sm">{labelFor(layer, s.step)}</span>
      </div>
    );
  }

  return (
    <div className="app">
      <div ref={mapContainer} className="map" />

      <aside className="panel">
        <header>
          <h1>Norway Hazard Map</h1>
          <p className="tag">Natural-disaster exposure for real estate</p>
        </header>

        <section className="search">
          <h2>Find an address</h2>
          <div className="search-box">
            <input
              type="text"
              value={query}
              onChange={onQueryChange}
              placeholder="e.g. Storgata 10, Lillestrøm"
              autoComplete="off"
            />
            {searching && <span className="spinner" />}
          </div>
          {results.length > 0 && (
            <ul className="results">
              {results.map((r, i) => (
                <li key={i}>
                  <button onClick={() => selectResult(r)}>
                    <strong>{r.text}</strong>
                    <em>{r.place}</em>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {mode === "point" && <p className="hint">📍 …or click anywhere on the map to score that spot.</p>}
        </section>

        <section>
          <h2>Mode</h2>
          <div className="mode-toggle">
            <button className={mode === "point" ? "on" : ""} onClick={() => selectMode("point")}>
              📍 Point
            </button>
            <button className={mode === "area" ? "on" : ""} onClick={() => selectMode("area")}>
              ⭕ Area
            </button>
          </div>
          {mode === "area" && (
            <>
              <div className="radius-row">
                <span>Radius</span>
                <input
                  type="range"
                  min={5}
                  max={50}
                  step={5}
                  value={areaRadius}
                  onChange={(e) => onRadiusChange(+e.target.value)}
                />
                <span className="radius-val">{areaRadius} km</span>
              </div>
              <p className="hint">⭕ Click the map to set the area centre (max 50 km).</p>
            </>
          )}
        </section>

        <section>
          <h2>
            Hazard layers <span className="zoom-now">zoom {Math.round(zoom)}</span>
          </h2>
          <ul className="layers">
            {HAZARD_LAYERS.map((h) => {
              const needsZoom = h.minZoom && visible[h.id] && zoom < h.minZoom;
              return (
                <li key={h.id}>
                  <label>
                    <input type="checkbox" checked={!!visible[h.id]} onChange={() => toggleHazard(h.id)} />
                    <span className="swatch" style={{ background: h.color }} />
                    <span className="label">
                      <strong>{h.label}</strong>
                      <em>
                        {h.sublabel}
                        {h.minZoom ? ` · visible at zoom ${h.minZoom}+` : " · visible at all zooms"}
                      </em>
                      {needsZoom && <em className="zoom-nudge">🔍 Zoom in to see (needs zoom {h.minZoom}+)</em>}
                    </span>
                  </label>
                  {/* Outside the <label>: a select nested in one competes with
                      the checkbox for the click. */}
                  {h.scenarios && (
                    <>
                      <select
                        className="scenario"
                        value={seaId}
                        onChange={(e) => onSeaChange(e.target.value)}
                        aria-label="Storm surge scenario"
                      >
                        {/* Grouped, because the list mixes two independent axes:
                            how rare the storm is, and how much sea level rise
                            is added on top. */}
                        {SEA_GROUPS.map((g) => (
                          <optgroup key={g} label={g}>
                            {h.scenarios
                              .filter((sc) => sc.group === g)
                              .map((sc) => (
                                <option key={sc.id} value={sc.id}>
                                  {sc.label}
                                </option>
                              ))}
                          </optgroup>
                        ))}
                      </select>
                      {/* Always visible rather than a tooltip: the labels are
                          jargon, and a hover hint is invisible on touch. */}
                      <p className="scenario-what">{seaScenario(seaId).what}</p>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section>
          <h2>Weather &amp; climate</h2>
          <ul className="layers">
            <li>
              <label>
                <input type="checkbox" checked={weatherOn} onChange={toggleWeather} />
                <span className="swatch live" />
                <span className="label">
                  <strong>
                    Precipitation radar <span className="badge">LIVE</span>
                  </strong>
                  <em>Real-time rain/snow radar — RainViewer. Timeline = last ~2 h loop.</em>
                </span>
              </label>
              {weatherOn && miniTimeline("radar")}
            </li>
            <li>
              <label>
                <input type="checkbox" checked={snowOn} onChange={toggleSnow} />
                <span className="swatch" style={{ background: "#7dd3fc" }} />
                <span className="label">
                  <strong>Snow cover</strong>
                  <em>Satellite snow (MODIS / NASA). Timeline = 12 months.</em>
                </span>
              </label>
              {snowOn && miniTimeline("snow")}
            </li>
          </ul>
        </section>

        <section>
          <h2>Earthquakes</h2>
          <ul className="layers">
            <li>
              <label>
                <input type="checkbox" checked={quakesOn} onChange={toggleQuakes} />
                <span className="swatch quake" />
                <span className="label">
                  <strong>Recorded earthquakes</strong>
                  <em>M2+ (USGS). Default: last 12 months. Hover a circle for details.</em>
                </span>
              </label>
              {quakesOn && (
                <div className="eq-controls">
                  <div className="eq-year">
                    <span>From year</span>
                    <input
                      type="number"
                      min={1990}
                      max={new Date().getFullYear()}
                      placeholder="e.g. 2010"
                      value={quakeYear}
                      onChange={(e) => setQuakeYear(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && applyQuakeYear()}
                    />
                    <button onClick={applyQuakeYear}>Show</button>
                    <button className="link" onClick={resetQuakeWindow}>
                      12 mo
                    </button>
                  </div>
                  {miniTimeline("quakes")}
                </div>
              )}
            </li>
          </ul>
        </section>

        <section>
          <h2>Basemap</h2>
          <select value={basemap} onChange={(e) => setBasemap(e.target.value)}>
            {Object.entries(BASEMAPS).map(([key, b]) => (
              <option key={key} value={key}>
                {b.label}
              </option>
            ))}
          </select>
        </section>

        <footer>
          <p>
            Hazards: <a href="https://www.nve.no" target="_blank" rel="noreferrer">NVE</a>. Quakes: USGS.
            Snow: NASA GIBS. Addresses &amp; map: Kartverket / OpenStreetMap. For screening only — not a
            substitute for a geotechnical assessment.
          </p>
        </footer>
      </aside>

      {risk && (
        <div className={"risk-card" + (riskMin ? " minimized" : "")}>
          <div className="risk-controls">
            {!risk.loading && !risk.error && !risk.outside && (
              <button className="risk-btn" onClick={exportPdf} disabled={pdfBusy} title="Export as PDF">
                {pdfBusy ? <><span className="spinner dark" />PDF</> : "⤓ PDF"}
              </button>
            )}
            <button
              className="risk-btn"
              onClick={() => setRiskMin((m) => !m)}
              title={riskMin ? "Expand" : "Minimize"}
            >
              {riskMin ? "▢" : "—"}
            </button>
            <button className="risk-btn" onClick={closeRisk} title="Close">
              ×
            </button>
          </div>
          {risk.loading ? (
            <p className="risk-status">
              <span className="spinner dark" /> Checking hazards at {risk.lat.toFixed(4)}, {risk.lng.toFixed(4)}…
            </p>
          ) : risk.error ? (
            <p className="risk-status">Lookup failed — try clicking again.</p>
          ) : risk.outside ? (
            <p className="risk-status">📍 Outside Norway — this map only covers Norwegian hazard data.</p>
          ) : (
            <>
              <div className={"risk-head " + (risk.overall === "at-risk" ? "bad" : "ok")}>
                {risk.overall === "at-risk"
                  ? `⚠️ ${risk.hitCount} hazard${risk.hitCount > 1 ? "s" : ""} at this location`
                  : "✓ No mapped hazards at this location"}
              </div>
              {!riskMin && (
                <>
              <ul className="risk-list">
                {risk.hazards.map((h) => (
                  <li key={h.id} className={h.inZone === true ? "hit" : h.inZone === null ? "unk" : "clear"}>
                    <span className="ic">{h.inZone === true ? "⚠️" : h.inZone === null ? "—" : "✓"}</span>
                    <span>
                      <strong>{h.label}.</strong> {h.detail}
                      {h.note && <em className="haz-note">{h.note}</em>}
                    </span>
                  </li>
                ))}
              </ul>
              {risk.warnings && (risk.warnings.flood || risk.warnings.landslide) && (
                <div className="risk-warn">
                  <span className="warn-title">⚡ Today's warnings ({risk.warnings.county})</span>
                  <span className="warn-pills">
                    {risk.warnings.flood && (
                      <span className={"pill lvl-" + risk.warnings.flood}>Flood: {risk.warnings.flood}</span>
                    )}
                    {risk.warnings.landslide && (
                      <span className={"pill lvl-" + risk.warnings.landslide}>
                        Landslide: {risk.warnings.landslide}
                      </span>
                    )}
                  </span>
                </div>
              )}

              {risk.context && (risk.context.weather || risk.context.climate || risk.context.quakes) && (
                <ul className="risk-context">
                  {risk.context.weather && (
                    <li>
                      🌦 <strong>Weather</strong>
                      {risk.context.weather.observedAt ? ` at ${risk.context.weather.observedAt}` : " now"}
                      {": "}
                      {risk.context.weather.text}
                    </li>
                  )}
                  {risk.context.climate && (
                    <li>💧 <strong>Climate:</strong> {risk.context.climate}</li>
                  )}
                  {risk.context.quakes && (
                    <li>🌍 <strong>Earthquakes:</strong> {risk.context.quakes}</li>
                  )}
                </ul>
              )}
              {pdfErr && <p className="pdf-err">{pdfErr}</p>}
              <p className="risk-foot">Screening only — confirm with a geotechnical assessment (NVE data).</p>
                </>
              )}
            </>
          )}
        </div>
      )}

      {area && (
        <div className={"risk-card area-card" + (areaMin ? " minimized" : "")}>
          <div className="risk-controls">
            {!area.loading && !area.error && !area.outside && (
              <button className="risk-btn" onClick={exportAreaPdf} disabled={pdfBusy} title="Export as PDF">
                {pdfBusy ? <><span className="spinner dark" />PDF</> : "⤓ PDF"}
              </button>
            )}
            <button className="risk-btn" onClick={() => setAreaMin((m) => !m)} title={areaMin ? "Expand" : "Minimize"}>
              {areaMin ? "▢" : "—"}
            </button>
            <button className="risk-btn" onClick={closeArea} title="Close">
              ×
            </button>
          </div>
          {area.loading ? (
            <p className="risk-status">
              <span className="spinner dark" /> Screening {area.radius} km area…
            </p>
          ) : area.error ? (
            <p className="risk-status">Lookup failed — try again.</p>
          ) : area.outside ? (
            <p className="risk-status">📍 Outside Norway — area screening only covers Norway.</p>
          ) : (
            <>
              <div className="risk-head ok">⭕ Area screening — {area.radius} km radius</div>
              {!areaMin && (
                <>
              <ul className="risk-list">
                {(area.hazards || []).map((h) => (
                  <li key={h.id} className={h.present ? "hit" : h.present === null ? "unk" : "clear"}>
                    <span className="ic">{h.present ? "⚠️" : h.present === null ? "—" : "✓"}</span>
                    <span>
                      <strong>{h.label}.</strong>{" "}
                      {h.present === null
                        ? "Lookup failed."
                        : h.present
                        ? `${h.count} mapped zone${h.count === 1 ? "" : "s"} intersect this area.`
                        : "No mapped zones in this area."}
                    </span>
                  </li>
                ))}
              </ul>
              <ul className="risk-context">
                {area.quakes && <li>🌍 <strong>Earthquakes:</strong> {area.quakes.text}</li>}
                {area.radon && <li>☢️ <strong>Radon:</strong> {area.radon.text}</li>}
              </ul>
              {pdfErr && <p className="pdf-err">{pdfErr}</p>}
              <p className="risk-foot">Counts = mapped hazard zones intersecting the circle (NVE). Screening only.</p>
                </>
              )}
            </>
          )}
        </div>
      )}

      {report && (
        <div className="report-overlay" role="dialog" aria-modal="true" aria-label={report.title}>
          <div className="report-bar">
            <strong>{report.title}</strong>
            <span className="grow" />
            <button onClick={printReport}>Print / Save as PDF</button>
            <button className="ghost" onClick={() => setReport(null)}>
              Close
            </button>
          </div>
          {/* srcDoc keeps the report same-origin, so its own script can print it
              and printReport() can reach contentWindow. Deliberately no sandbox
              attribute: sandboxing blocks both. */}
          <iframe ref={reportFrameRef} className="report-frame" srcDoc={report.html} title={report.title} />
        </div>
      )}
    </div>
  );
}
