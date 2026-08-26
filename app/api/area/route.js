// Area screening: given a centre + radius (≤50 km), returns earthquakes in the
// radius, which hazard zones intersect the circle (scale-independent ArcGIS
// feature-count queries), and a radon class sample.
//
// NOTE: we query feature COUNTS (not rendered-pixel coverage) because most NVE
// hazard layers are scale-gated (minScale) and don't render at a 50 km extent —
// a query intersects the real geometry regardless of zoom.
import { inNorway } from "../../../lib/norway-border";
import { SEA_DEFAULT, seaScenario } from "../../../lib/layers";

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


/**
 * Where to aim a detail map: the point on a hazard polygon's boundary closest to
 * the circle centre.
 *
 * Vertices alone are not enough. A polygon can cross the circle while every one
 * of its vertices sits outside it, so a vertex scan reports "nothing here" for a
 * hazard that plainly overlaps. Measuring to the line SEGMENTS fixes that: if the
 * boundary enters the circle at all, the closest boundary point is inside it.
 *
 * When no boundary point is within the radius and `enclosing` is set, the polygon
 * must ENCLOSE the circle, because a true-circle query already established that
 * it intersects the circle. The centre is then itself on the hazard and is the
 * right place to aim.
 *
 * `enclosing` must stay false for bounding-box queries such as the WFS one: a
 * polygon can clip a box corner without touching the circle, and claiming the
 * centre is on the hazard would then be simply false. Verified at Stavanger,
 * whose centre is outside every surge zone.
 *
 * Distances use a local flat approximation, accurate well past the 50 km maximum
 * radius, and it avoids a haversine per segment.
 */
function pickFocus(rings, lng, lat, radiusKm, enclosing) {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  const ky = 110.57;
  let best = null;
  let bestD = Infinity;
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1];
      const b = ring[i];
      if (!isFinite(a.lng) || !isFinite(b.lng)) continue;
      const ax = (a.lng - lng) * kx;
      const ay = (a.lat - lat) * ky;
      const bx = (b.lng - lng) * kx;
      const by = (b.lat - lat) * ky;
      const dx = bx - ax;
      const dy = by - ay;
      const len = dx * dx + dy * dy;
      let t = len ? -(ax * dx + ay * dy) / len : 0;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + t * dx;
      const cy = ay + t * dy;
      const d = Math.hypot(cx, cy);
      if (d < bestD) {
        bestD = d;
        best = { lng: lng + cx / kx, lat: lat + cy / ky };
      }
    }
  }
  if (!best) return null;
  if (bestD <= radiusKm) return best;
  return enclosing ? { lng, lat, atCentre: true } : null;
}

function circleQueryUrl(h, lng, lat, radiusKm, extra) {
  const p = new URLSearchParams({
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    distance: String(Math.round(radiusKm * 1000)),
    units: "esriSRUnit_Meter",
    spatialRel: "esriSpatialRelIntersects",
    f: "json",
    ...extra,
  });
  return `${NVE}/${h.service}/MapServer/${h.layer}/query?${p.toString()}`;
}

/**
 * A point on one of the matching hazard polygons, inside the circle, in lng/lat.
 * Used to aim the PDF's per-hazard detail map: a 25 km circle is far above NVE's
 * render-scale gate, so a full-circle hazard map comes back blank and the detail
 * map has to zoom in, which only helps if it points somewhere the hazard is.
 *
 * `outSR=3857` is required. Without it geometry returns in the layer's native SR
 * and the point lands in the North Sea. `maxAllowableOffset` keeps the response
 * small; at detail-map scale the generalisation is invisible.
 */
async function focusOf(h, lng, lat, radiusKm) {
  try {
    const r = await fetch(
      circleQueryUrl(h, lng, lat, radiusKm, {
        resultRecordCount: "8",
        returnGeometry: "true",
        outSR: "4326",
        maxAllowableOffset: "0.0004", // ~40 m, in outSR degrees
        outFields: "",
      }),
      { signal: AbortSignal.timeout(20000) }
    );
    const feats = (await r.json()).features || [];
    const rings = [];
    for (const f of feats) {
      for (const ring of (f.geometry && f.geometry.rings) || []) {
        rings.push(ring.map((q) => ({ lng: q[0], lat: q[1] })));
      }
    }
    return rings.length ? pickFocus(rings, lng, lat, radiusKm, true) : null;
  } catch {
    return null;
  }
}

async function countInCircle(h, lng, lat, radiusKm) {
  try {
    // Count and focus run concurrently so the extra lookup does not slow the
    // interactive card.
    const [r, focus] = await Promise.all([
      fetch(circleQueryUrl(h, lng, lat, radiusKm, { returnCountOnly: "true" }), {
        signal: AbortSignal.timeout(20000),
      }),
      focusOf(h, lng, lat, radiusKm),
    ]);
    const j = await r.json();
    const count = typeof j.count === "number" ? j.count : null;
    const present = count != null && count > 0;
    return { id: h.id, label: h.label, count, present, focus: present ? focus : null };
  } catch {
    return { id: h.id, label: h.label, count: null, present: null, focus: null };
  }
}

// ---------------------------------------------------------------------------
// Storm surge / sea level (Kartverket) uses WFS rather than ArcGIS.
//
// `resulttype=hits` returns a count in a couple of hundred bytes. Fetching the
// features instead would pull megabytes, because a single surge polygon can
// trace a whole stretch of coastline.
//
// The area test is a TRUE circle, built as a polygon and passed to `Intersects`.
// A bounding box is not good enough: its corners reach r * sqrt(2), and at a 5 km
// radius near Sandnes the box matched 7 surge polygons while the circle matched
// none. That reported storm surge in an area that has none, and then drew an
// empty detail map because there was nothing inside to show.
//
// DWithin would be the natural operator and the service advertises it, but this
// server accepts it and silently ignores it, returning all 125 209 features.
// BBOX and Intersects are both applied correctly, so the circle is polygonised.
//
// Also note: `srsName` is worth setting on the geometry request. In the service's
// native CRS one feature came back as 1.6 MB, versus 2.7 KB in 4326.
// ---------------------------------------------------------------------------
const WFS_STORMFLO = "https://wfs.geonorge.no/skwms1/wfs.stormflo_havniva";
const SF_NS = "https://skjema.geonorge.no/SOSI/produktspesifikasjon/StormfloHavniva/20240220";

// One surge polygon can carry six figures of vertices, so the scan is bounded.
const MAX_SEA_VERTICES = 500000;

// 48 segments keeps the polygon within ~0.2% of a true circle, which is far
// tighter than the data warrants.
const CIRCLE_SEGMENTS = 48;

/** The screening circle as a GML LinearRing, in lat lon order to match the CRS. */
function circleRingGml(lng, lat, radiusKm) {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  const ky = 110.57;
  const pts = [];
  for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
    const a = (2 * Math.PI * i) / CIRCLE_SEGMENTS;
    const plat = lat + (radiusKm * Math.sin(a)) / ky;
    const plng = lng + (radiusKm * Math.cos(a)) / kx;
    pts.push(`${plat.toFixed(6)} ${plng.toFixed(6)}`);
  }
  return pts.join(" ");
}

function wfsUrl(sc, lng, lat, radiusKm, extra) {
  const filter =
    `<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0" xmlns:gml="http://www.opengis.net/gml/3.2"` +
    ` xmlns:app="${SF_NS}"><fes:Intersects>` +
    `<fes:ValueReference>app:omr\u00e5de</fes:ValueReference>` +
    `<gml:Polygon srsName="urn:ogc:def:crs:EPSG::4326"><gml:exterior><gml:LinearRing>` +
    `<gml:posList>${circleRingGml(lng, lat, radiusKm)}</gml:posList>` +
    `</gml:LinearRing></gml:exterior></gml:Polygon></fes:Intersects></fes:Filter>`;
  const p = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typenames: `app:${sc.wfs}`,
    namespaces: `xmlns(app,${SF_NS})`,
    filter,
    ...extra,
  });
  return `${WFS_STORMFLO}?${p.toString()}`;
}

async function seaInCircle(lng, lat, radius, scenarioId) {
  const sc = seaScenario(scenarioId);
  const base = { id: "sea-level", label: "Storm surge & sea level", scenario: sc.id, scenarioLabel: sc.label, note: sc.what };
  try {
    const [hitsRes, focusRes] = await Promise.allSettled([
      fetch(wfsUrl(sc, lng, lat, radius, { resulttype: "hits" }), { signal: AbortSignal.timeout(25000) }).then((r) =>
        r.text()
      ),
      fetch(wfsUrl(sc, lng, lat, radius, { count: "8", srsName: "urn:ogc:def:crs:EPSG::4326" }), {
        signal: AbortSignal.timeout(25000),
      }).then((r) => r.text()),
    ]);
    if (hitsRes.status !== "fulfilled") return { ...base, count: null, present: null, focus: null };
    const m = hitsRes.value.match(/numberMatched="(\d+)"/);
    const count = m ? parseInt(m[1], 10) : null;
    const present = count != null && count > 0;
    let focus = null;
    if (present && focusRes.status === "fulfilled") {
      const rings = [];
      let seen = 0;
      for (const g of focusRes.value.matchAll(/<gml:posList[^>]*>([^<]+)</g)) {
        const nums = g[1].trim().split(/\s+/);
        const ring = [];
        // posList for a 4326 geometry is lat lon, matching the bbox order.
        for (let i = 0; i + 1 < nums.length && seen < MAX_SEA_VERTICES; i += 2, seen++) {
          ring.push({ lat: parseFloat(nums[i]), lng: parseFloat(nums[i + 1]) });
        }
        if (ring.length > 1) rings.push(ring);
      }
      // A true circle intersect, so the enclosing inference is sound here too:
      // a matched polygon with no boundary inside the circle must contain it.
      focus = rings.length ? pickFocus(rings, lng, lat, radius, true) : null;
    }
    return { ...base, count, present, focus };
  } catch {
    return { ...base, count: null, present: null, focus: null };
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
  const seaId = searchParams.get("sea") || SEA_DEFAULT;

  if (!inNorway(lng, lat)) return Response.json({ lng, lat, radius, outside: true });

  const c = toMerc(lng, lat);
  const rMerc = (radius * 1000) / Math.cos((lat * Math.PI) / 180);
  const ext = `${c.x - rMerc},${c.y - rMerc},${c.x + rMerc},${c.y + rMerc}`;

  const [quakes, radon, sea, ...hazards] = await Promise.all([
    fetchAreaQuakes(lng, lat, radius, fromMs),
    fetchAreaRadon(lng, lat, radius),
    seaInCircle(lng, lat, radius, seaId),
    ...HAZARDS.map((h) => countInCircle(h, lng, lat, radius)),
  ]);

  return Response.json({ lng, lat, radius, quakes, radon, hazards: [...hazards, sea] });
}
