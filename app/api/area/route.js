// Area screening: given a centre + radius (≤50 km), returns earthquakes in the
// radius, which hazard zones intersect the circle (scale-independent ArcGIS
// feature-count queries), and a radon class sample.
//
// NOTE: we query feature COUNTS (not rendered-pixel coverage) because most NVE
// hazard layers are scale-gated (minScale) and don't render at a 50 km extent —
// a query intersects the real geometry regardless of zoom.
import { inNorway } from "../../../lib/norway-border";

const NVE = "https://gis3.nve.no/map/rest/services";

// One queryable hazard-polygon layer per map hazard layer.
const HAZARDS = [
  { id: "flood", label: "Flood", service: "Mapservices/FlomsoneKart2", layer: 22 }, // Flomsone_200ar
  { id: "landslide", label: "Landslide & quick-clay", service: "Skredfaresoner3", layer: 7 }, // Skredfaresone_1000
  { id: "snow", label: "Snow avalanche", service: "SnoskredAktsomhet", layer: 2 }, // S2 aktsomhet
  { id: "rock", label: "Rock avalanche", service: "Fjellskred1", layer: 8 }, // Faresoner_fjellskred_sammensat
];

function toMerc(lng, lat) {
  const R = 6378137;
  return { x: (R * lng * Math.PI) / 180, y: R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) };
}

function unMerc(x, y) {
  const R = 6378137;
  return { lng: (x / R) * (180 / Math.PI), lat: (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI) };
}

function queryUrl(h, ext, extra) {
  const p = new URLSearchParams({
    geometry: ext,
    geometryType: "esriGeometryEnvelope",
    inSR: "3857",
    spatialRel: "esriSpatialRelIntersects",
    f: "json",
    ...extra,
  });
  return `${NVE}/${h.service}/MapServer/${h.layer}/query?${p.toString()}`;
}

/**
 * A point that actually sits on one of the matching hazard polygons, in lng/lat.
 * Used to aim the PDF's per-hazard detail map: a 25 km circle is far above
 * NVE's render-scale gate, so a full-circle hazard map comes back blank and the
 * detail map has to zoom in — which only helps if it's pointed somewhere the
 * hazard exists.
 *
 * We take ONE feature and use its ring centroid rather than the bounding box of
 * all matches: with features scattered around a 25 km circle, the overall
 * bbox centre usually falls in a gap between them. Measured on snow avalanche
 * at Lillestrøm, the bbox centre rendered 0.01% coverage vs 1.94% here.
 * `outSR=3857` is required — without it geometry returns in the layer's native
 * SR and the point lands in the North Sea.
 */
async function focusOf(h, ext) {
  try {
    const r = await fetch(
      queryUrl(h, ext, { resultRecordCount: "1", returnGeometry: "true", outSR: "3857", outFields: "" }),
      { signal: AbortSignal.timeout(20000) }
    );
    const f = ((await r.json()).features || [])[0];
    const rings = f && f.geometry && f.geometry.rings;
    if (!rings || !rings.length) return null;
    const pts = rings.flat();
    if (!pts.length) return null;
    let sx = 0, sy = 0;
    for (const p of pts) {
      if (!isFinite(p[0]) || !isFinite(p[1])) return null;
      sx += p[0];
      sy += p[1];
    }
    return unMerc(sx / pts.length, sy / pts.length);
  } catch {
    return null;
  }
}

async function countInCircle(h, ext) {
  try {
    // Envelope (circle bbox) — GET-safe and reliable. Slightly over-counts at
    // the corners vs the true circle, fine for area screening.
    // Count and extent run concurrently so adding the focus lookup doesn't
    // slow the interactive card.
    const [r, focus] = await Promise.all([
      fetch(queryUrl(h, ext, { returnCountOnly: "true" }), { signal: AbortSignal.timeout(20000) }),
      focusOf(h, ext),
    ]);
    const j = await r.json();
    const count = typeof j.count === "number" ? j.count : null;
    const present = count != null && count > 0;
    return { id: h.id, label: h.label, count, present, focus: present ? focus : null };
  } catch {
    return { id: h.id, label: h.label, count: null, present: null, focus: null };
  }
}

async function fetchAreaQuakes(lng, lat, radius, fromMs) {
  try {
    const startDate = new Date(fromMs).toISOString().slice(0, 10);
    const days = (Date.now() - fromMs) / 86400000;
    const since = days <= 400 ? "in the past 12 months" : `since ${new Date(fromMs).getFullYear()}`;
    const u = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=${lat}&longitude=${lng}&maxradiuskm=${radius}&starttime=${startDate}&minmagnitude=2`;
    const f = (await (await fetch(u, { signal: AbortSignal.timeout(15000) })).json()).features || [];
    if (!f.length) return { count: 0, text: `Nothing of magnitude 2 or above ${since}.` };
    // Most recent event, matching the point report.
    let latest = null;
    for (const x of f) {
      const p = x.properties;
      if (!latest || p.time > latest.time) latest = { time: p.time, mag: p.mag };
    }
    const when = new Date(latest.time).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    return {
      count: f.length,
      text: `${f.length} of magnitude 2 or above ${since}. The most recent was M${latest.mag} on ${when}.`,
    };
  } catch {
    return null;
  }
}

async function radonClassAt(lng, lat) {
  try {
    const m = toMerc(lng, lat);
    const d = 200;
    const u =
      `https://geo.ngu.no/mapserver/RadonWMS2?service=WMS&version=1.1.1&request=GetFeatureInfo` +
      `&layers=Radon_aktsomhet&query_layers=Radon_aktsomhet&srs=EPSG:3857&bbox=${m.x - d},${m.y - d},${m.x + d},${m.y + d}` +
      `&width=51&height=51&x=25&y=25&info_format=application/vnd.ogc.gml`;
    const t = await (await fetch(u, { signal: AbortSignal.timeout(12000) })).text();
    const grads = [...t.matchAll(/<aktsomhetgrad>(\d+)<\/aktsomhetgrad>/g)].map((x) => parseInt(x[1], 10));
    const besks = [...t.matchAll(/<aktsomhetgrad_besk>([^<]+)<\/aktsomhetgrad_besk>/g)].map((x) => x[1].trim());
    if (!grads.length) return null;
    const g = Math.max(...grads);
    return { grad: g, besk: besks[grads.indexOf(g)] || "" };
  } catch {
    return null;
  }
}
async function fetchAreaRadon(lng, lat, radius) {
  const r = 0.6 * radius;
  const dLat = r / 111;
  const dLng = r / (111 * Math.cos((lat * Math.PI) / 180));
  const pts = [[lng, lat], [lng, lat + dLat], [lng, lat - dLat], [lng + dLng, lat], [lng - dLng, lat]];
  const results = (await Promise.all(pts.map((p) => radonClassAt(p[0], p[1])))).filter(Boolean);
  if (!results.length) return null;
  const elevated = results.filter((r) => r.grad >= 2).length;
  const top = results.reduce((a, b) => (b.grad > a.grad ? b : a));
  return {
    text: elevated
      ? `${elevated} of ${results.length} sampled points showed elevated radon. The highest class found was ${top.besk}.`
      : `None of the ${results.length} sampled points showed elevated radon. The highest class found was ${top.besk}.`,
  };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const lng = parseFloat(searchParams.get("lng"));
  const lat = parseFloat(searchParams.get("lat"));
  let radius = parseFloat(searchParams.get("radius"));
  if (!isFinite(lng) || !isFinite(lat)) return Response.json({ error: "lng/lat required" }, { status: 400 });
  if (!isFinite(radius)) radius = 25;
  radius = Math.max(1, Math.min(50, radius));
  const fromMs = parseInt(searchParams.get("from"), 10) || Date.now() - 365 * 86400000;

  if (!inNorway(lng, lat)) return Response.json({ lng, lat, radius, outside: true });

  const c = toMerc(lng, lat);
  const rMerc = (radius * 1000) / Math.cos((lat * Math.PI) / 180);
  const ext = `${c.x - rMerc},${c.y - rMerc},${c.x + rMerc},${c.y + rMerc}`;

  const [quakes, radon, ...hazards] = await Promise.all([
    fetchAreaQuakes(lng, lat, radius, fromMs),
    fetchAreaRadon(lng, lat, radius),
    ...HAZARDS.map((h) => countInCircle(h, ext)),
  ]);

  return Response.json({ lng, lat, radius, quakes, radon, hazards });
}
