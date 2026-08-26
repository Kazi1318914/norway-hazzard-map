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
];

// ---------------------------------------------------------------------------
// Basemaps. Primary = Kartverket grayscale (Norwegian official, open, no key).
// Fallback = Carto light (global) so the app always shows *something* even if
// Kartverket is down or blocked. Both are EPSG:3857 web-mercator XYZ tiles.
// ---------------------------------------------------------------------------
export const BASEMAPS = {
  kartverket: {
    label: "Kartverket (grayscale)",
    tiles: [
      "https://cache.kartverket.no/v1/wmts/1.0.0/topograatone/default/webmercator/{z}/{y}/{x}.png",
    ],
    attribution: "© Kartverket",
  },
  carto: {
    label: "Carto Light (fallback)",
    tiles: [
      "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
      "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    ],
    attribution: "© OpenStreetMap, © CARTO",
  },
};

// Centered on Norway, zoomed out to show the whole mainland.
export const INITIAL_VIEW = {
  center: [13.5, 64.5], // lng, lat — roughly central Norway
  zoom: 4.2,
  minZoom: 3,
  maxZoom: 17,
};
