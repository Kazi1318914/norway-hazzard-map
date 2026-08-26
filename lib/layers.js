// ---------------------------------------------------------------------------
// Data sources for the Norway natural-hazard map.
//
// All hazard layers come from NVE (Norges vassdrags- og energidirektorat),
// served from their public ArcGIS REST servers. We use each service's
// `export` operation, which renders ALL visible sub-layers of the service as a
// single transparent PNG for a given bounding box. This avoids having to know
// the exact internal WMS layer names — one endpoint = one toggleable overlay.
//
// MapLibre fills in {bbox-epsg-3857} per raster tile request.
//
// To add a hazard: copy a block below and change `id`, `label`, `color`, and
// the service name in the URL. To find more services, browse:
//   https://nve.geodataonline.no/arcgis/rest/services
// ---------------------------------------------------------------------------

// NVE's public ArcGIS REST server. NOTE: the host is gis3.nve.no and the path
// is /map/rest/services (NOT the old nve.geodataonline.no host, which no longer
// resolves). Service names below were verified live against this server.
const NVE_BASE = "https://gis3.nve.no/map/rest/services";

/** Build an ArcGIS MapServer `export` tile URL template for MapLibre.
 * Most NVE services have ALL sublayers defaultVisibility=false, so without an
 * explicit `layers=show:<ids>` the export renders nothing. Pass the hazard
 * polygon layer ids to force them on. (Skredfaresoner3's layers are visible by
 * default, so it needs no `show`.) */
function nveExport(service, show) {
  return (
    `${NVE_BASE}/${service}/MapServer/export` +
    `?bbox={bbox-epsg-3857}` +
    `&bboxSR=3857&imageSR=3857` +
    `&size=512,512` +
    `&dpi=96` +
    `&format=png32` +
    `&transparent=true` +
    (show ? `&layers=show:${show}` : "") +
    `&f=image`
  );
}

// ---------------------------------------------------------------------------
// Kartverket "Stormflo og havnivå" (storm surge and sea level rise).
//
// A plain WMS, so it rides the same {bbox-epsg-3857} raster mechanism as the
// NVE exports. Unlike the NVE layers this one has SCENARIOS rather than a
// single extent: a return period (20 / 200 / 1000-year surge) crossed with a
// climate year (today / 2100 / 2150). They are listed in roughly increasing
// severity so the picker reads as a progression.
//
// `wfs` is the matching WFS feature-type name, used for area counting. The
// spelling differs from the WMS layer name (Å, Ø, å) and is not derivable from
// it, so both are recorded here.
//
// NOTE: the service also publishes a `dekningsomrade` (coverage) layer. It
// returns a feature even at Lillehammer, far inland, so it means "inside the
// national product" and NOT "surge reaches here". It is deliberately absent.
// ---------------------------------------------------------------------------
const KV_STORMFLO = "https://wms.geonorge.no/skwms1/wms.stormflo_havniva";

// `group` drives the <optgroup> headings, and `what` is the plain-language
// meaning shown under the picker and carried into the report. A label like
// "Upper estimate, 2150" tells a buyer nothing on its own.
//
// The TEK17 classes below are not guesses: the service returns
// `sikkerhetsklasseflom` per zone, and it reads F1 on the 20-year layer, F2 on
// the 200-year and F3 on the 1000-year. Mean high water and the upper estimates
// carry no class, because neither is a regulatory threshold.
export const SEA_SCENARIOS = [
  {
    id: "middelhoyvann_klimaarna",
    wfs: "Middelh\u00f8yvann_Klima\u00c5rN\u00e5",
    label: "Mean high water, today",
    group: "Normal high tide",
    what: "The average daily high tide as things stand. Ground below this line is already tidal, not at risk of becoming so.",
  },
  {
    id: "middelhoyvann_klimaar2100",
    wfs: "Middelh\u00f8yvann_Klima\u00c5r2100",
    label: "Mean high water, 2100",
    group: "Normal high tide",
    what: "Where the ordinary daily high tide is projected to sit in 2100. No storm involved.",
  },
  {
    id: "middelhoyvann_klimaar2150",
    wfs: "Middelh\u00f8yvann_Klima\u00c5r2150",
    label: "Mean high water, 2150",
    group: "Normal high tide",
    what: "Where the ordinary daily high tide is projected to sit in 2150. No storm involved.",
  },
  {
    id: "stormflo20ar_klimaarna",
    wfs: "Stormflo20\u00c5r_Klima\u00c5rN\u00e5",
    label: "20-year surge, today",
    group: "Storm surge at today's sea level",
    what: "A storm surge with roughly a 1-in-20 chance of being reached in any year. TEK17 safety class F1, the bar used for garages and outbuildings.",
  },
  {
    id: "stormflo200ar_klimaarna",
    wfs: "Stormflo200\u00c5r_Klima\u00c5rN\u00e5",
    label: "200-year surge, today",
    group: "Storm surge at today's sea level",
    what: "A storm surge with roughly a 1-in-200 chance in any year. TEK17 safety class F2, the bar that applies to housing.",
  },
  {
    id: "stormflo1000ar_klimaarna",
    wfs: "Stormflo1000\u00c5r_Klima\u00c5rN\u00e5",
    label: "1000-year surge, today",
    group: "Storm surge at today's sea level",
    what: "A storm surge with roughly a 1-in-1000 chance in any year. TEK17 safety class F3, the bar for hospitals and emergency buildings.",
  },
  {
    id: "stormflo200ar_klimaar2100",
    wfs: "Stormflo200\u00c5r_Klima\u00c5r2100",
    label: "200-year surge, 2100",
    group: "Storm surge plus sea level rise",
    what: "The 1-in-200 storm surge with sea level rise to 2100 added. This is the case new housing is normally planned against, so it is the default here.",
  },
  {
    id: "stormflo1000ar_klimaar2100",
    wfs: "Stormflo1000\u00c5r_Klima\u00c5r2100",
    label: "1000-year surge, 2100",
    group: "Storm surge plus sea level rise",
    what: "The 1-in-1000 storm surge with sea level rise to 2100 added. Class F3 buildings are held to this.",
  },
  {
    id: "stormfloovreestimat_klimaar2100",
    wfs: "Stormflo\u00d8vreEstimat_Klima\u00c5r2100",
    label: "Upper estimate, 2100",
    group: "Precautionary upper estimate",
    what: "The high end of Kartverket's sea level rise range for 2100 rather than the central figure. A worst-case sanity check, not a regulatory line.",
  },
  {
    id: "stormfloovreestimat_klimaar2150",
    wfs: "Stormflo\u00d8vreEstimat_Klima\u00c5r2150",
    label: "Upper estimate, 2150",
    group: "Precautionary upper estimate",
    what: "The high end of the sea level rise range for 2150. The most pessimistic line the service publishes.",
  },
];

// Groups in picker order, derived so the list and the headings cannot drift.
export const SEA_GROUPS = [...new Set(SEA_SCENARIOS.map((s) => s.group))];

// TEK17 puts most housing in flood safety class F2, i.e. the 200-year event,
// and planning is expected to allow for sea level rise. That makes the
// 200-year surge in 2100 the scenario a buyer or builder actually needs.
export const SEA_DEFAULT = "stormflo200ar_klimaar2100";

export function seaScenario(id) {
  return SEA_SCENARIOS.find((s) => s.id === id) || SEA_SCENARIOS.find((s) => s.id === SEA_DEFAULT);
}

/** WMS GetMap template for one surge scenario. EPSG:3857 is projected, so
 *  1.3.0 keeps x,y axis order here and the bbox needs no flipping. */
export function seaTiles(scenarioId) {
  const s = seaScenario(scenarioId);
  return (
    `${KV_STORMFLO}?service=WMS&version=1.3.0&request=GetMap` +
    `&layers=${s.id}&styles=&crs=EPSG:3857&bbox={bbox-epsg-3857}` +
    `&width=512&height=512&format=image/png&transparent=true`
  );
}

// ---------------------------------------------------------------------------
// Hazard overlays. `color` is only used for the legend swatch — the actual
// rendering colors come from NVE's own cartography in the returned images.
// ---------------------------------------------------------------------------
export const HAZARD_LAYERS = [
  {
    id: "flood-zones",
    label: "Flood zones",
    sublabel: "Flomsonekart — modelled flood extents",
    color: "#2563eb",
    // Flomsone_* zone polygons (10/20/50/100/200/500/1000-yr + 200-klima).
    tiles: nveExport("Mapservices/FlomsoneKart2", "6,10,14,18,22,26,30,34"),
    defaultOn: true,
    minZoom: 9, // NVE minScale 1:160 000 — invisible until ~zoom 9
    // NVE suppresses these sublayers above this scale, so a wide extent renders
    // an empty PNG. PDF detail thumbnails shrink their extent to clear it.
    maxScale: 160000,
  },
  {
    id: "landslide-zones",
    label: "Landslide & quick-clay hazard zones",
    sublabel: "Skredfaresoner — mapped hazard zones incl. kvikkleire",
    color: "#b45309",
    tiles: nveExport("Skredfaresoner3"),
    defaultOn: true,
  },
  {
    id: "snow-avalanche",
    label: "Snow avalanche susceptibility",
    sublabel: "Snøskred aktsomhetsområde",
    color: "#7c3aed",
    // S2/S3 snøskred aktsomhetsområde polygons.
    tiles: nveExport("SnoskredAktsomhet", "1,2,3"),
    defaultOn: false,
    minZoom: 10, // NVE minScale 1:80 000 — invisible until ~zoom 10
    maxScale: 80000,
  },
  {
    id: "rock-avalanche",
    label: "Rock avalanche",
    sublabel: "Fjellskred — faresoner & unstable rock slopes",
    color: "#6b7280",
    // Faresoner_fjellskred (renders at all zooms) + combined faresoner/tsunami.
    tiles: nveExport("Fjellskred1", "7,8,9"),
    defaultOn: false,
    maxScale: 320000, // ids 8,9 are gated at 1:320 000 (id 7 is not)
  },
  {
    // NGU radon susceptibility (different host/standard: a WMS GetMap, not the
    // NVE ArcGIS export — but it plugs into the same {bbox-epsg-3857} raster
    // mechanism, so it's just another hazard layer here).
    id: "radon",
    label: "Radon susceptibility",
    sublabel: "Radon aktsomhet — NGU (bedrock/soil based)",
    color: "#db2777",
    tiles:
      "https://geo.ngu.no/mapserver/RadonWMS2?service=WMS&version=1.1.1&request=GetMap" +
      "&layers=Radon_aktsomhet&styles=&srs=EPSG:3857&bbox={bbox-epsg-3857}" +
      "&width=512&height=512&format=image/png&transparent=true",
    defaultOn: false,
  },
  {
    // Kartverket storm surge / sea level rise. Scenario-driven: `tiles` is only
    // the default, and the client swaps it with seaTiles() via setTiles().
    id: "sea-level",
    label: "Storm surge & sea level",
    sublabel: "Stormflo og havniv\u00e5 \u2014 Kartverket",
    color: "#0891b2",
    tiles: seaTiles(SEA_DEFAULT),
    defaultOn: false,
    minZoom: 10, // WMS MaxScaleDenominator 80 000 \u2014 invisible until ~zoom 10
    maxScale: 80000,
    scenarios: SEA_SCENARIOS,
    defaultScenario: SEA_DEFAULT,
  },
];

// ---------------------------------------------------------------------------
// Basemaps. Both are keyless, which is the whole requirement here.
//
// Primary = Kartverket grayscale, the Norwegian national map. The right default
// for a Norway-only tool, and the most detailed at close zoom.
//
// Fallback = Esri World Light Gray Base, global, so the app still shows
// something if Kartverket is slow or blocked from where the visitor is.
//
// CARTO's light_all used to be the fallback AND the default. It now stamps
// "API KEY REQUIRED / carto.com/basemaps/apikey" diagonally across every tile.
// It still answers 200 with a valid PNG, so nothing throws and no console
// warning appears; the watermark just shows up on the map. Removed rather than
// left as an option, since a visibly broken choice is worse than no choice.
// ---------------------------------------------------------------------------
export const BASEMAPS = {
  kartverket: {
    label: "Kartverket (grayscale)",
    tiles: [
      "https://cache.kartverket.no/v1/wmts/1.0.0/topograatone/default/webmercator/{z}/{y}/{x}.png",
    ],
    attribution: "\u00a9 Kartverket",
  },
  esri: {
    label: "Esri Light Gray (global fallback)",
    // Note the {z}/{y}/{x} order, and that it serves JPEG despite no extension.
    tiles: [
      "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    ],
    attribution: "\u00a9 Esri, HERE, Garmin, \u00a9 OpenStreetMap contributors",
  },
};

// Centered on Norway, zoomed out to show the whole mainland.
export const INITIAL_VIEW = {
  center: [13.5, 64.5], // lng, lat — roughly central Norway
  zoom: 4.2,
  minZoom: 3,
  maxZoom: 17,
};
