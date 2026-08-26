// Server-side risk lookup. The browser calls /api/risk?lng=..&lat=.. and this
// route queries NVE's ArcGIS `identify` endpoints server-side (avoids CORS) for
// every hazard the map shows, then returns a clean verdict.
//
// Each check mirrors a map hazard layer. Some NVE services include a coverage /
// index polygon (e.g. "Dekningskart", "Kartleggingsomrade", flood "Analyse-
// omrade") that only means "this area was assessed" — NOT that a hazard exists.
// Those are filtered out so we don't report false positives.

import { inNorway } from "../../../lib/norway-border";
import { SEA_DEFAULT, seaScenario } from "../../../lib/layers";

const NVE = "https://gis3.nve.no/map/rest/services";

// Layers that mean "this area was assessed / potentially mappable", not "a
// hazard exists here". `PotensieltSkredfareOmr` is a near-national polygon that
// even covers open sea, so it must be excluded — the real snow-avalanche zones
// are the "...Aktsomhetsomrade" layers.
const COVERAGE_RE = /dekningskart|kartleggingsomr|analyseomr|utbredelse|coverage|potensiel/i;

// One entry per hazard layer on the map. `services` are queried together.
const CHECKS = [
  {
    id: "flood",
    label: "Flood",
    services: ["Mapservices/FlomsoneKart2"],
    // Only the Flomsone_* polygons are the flood zone itself. The same service
    // also publishes Flomutsatte_bygg_* — the individual BUILDINGS that flood,
    // as points — and those were establishing the verdict on their own. At
    // Drammen no flood-zone polygon covers the point, yet exposed buildings fell
    // inside the identify tolerance, so the report claimed "inside a flood zone"
    // for a site that is outside every one of them.
    zoneRe: /^Flomsone_/i,
  },
  {
    id: "landslide",
    label: "Landslide & quick-clay",
    services: ["Skredfaresoner3", "Mapservices/SVV_kvikkleireomrade"],
  },
  { id: "snow", label: "Snow avalanche", services: ["SnoskredAktsomhet"] },
  { id: "rock", label: "Rock avalanche", services: ["Fjellskred1"] },
];

async function identify(service, lng, lat) {
  const d = 0.02; // ~1.5–2 km half-window for the pixel-based tolerance
  const ext = `${lng - d},${lat - d},${lng + d},${lat + d}`;
  const p = new URLSearchParams({
    geometry: `${lng},${lat}`,
    geometryType: "esriGeometryPoint",
    sr: "4326",
    tolerance: "4",
    mapExtent: ext,
    imageDisplay: "600,600,96",
    layers: "all",
    returnGeometry: "false",
    f: "json",
  });
  const res = await fetch(`${NVE}/${service}/MapServer/identify?${p.toString()}`, {
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json();
  return j.results || [];
}

function distinct(results, key) {
  const s = new Set();
  for (const r of results) {
    const v = r.attributes && r.attributes[key];
    if (v && v !== "Null" && v !== "null") s.add(String(v).trim());
  }
  return [...s];
}

function detailFor(id, hits, all) {
  if (id === "flood") {
    const name = distinct(all, "flomsoneNavn")[0];
    // Read the return period off the LAYER NAME, never off `gjentaksinterval`.
    // On the climate-adjusted layer NVE stores the climate YEAR in that field, so
    // Flomsone_200ar_klima reports 2100 and the old text read "the 2100-year
    // flood" — a return period that does not exist. The layer names are the
    // reliable source: Flomsone_10ar through Flomsone_1000ar, plus
    // Flomsone_200ar_klima.
    const periods = new Set();
    let klima = false;
    for (const r of hits) {
      const m = /^Flomsone_(\d+)ar(_klima)?$/i.exec(String(r.layerName || "").trim());
      if (!m) continue;
      periods.add(parseInt(m[1], 10));
      if (m[2]) klima = true;
    }
    const iv = [...periods].sort((a, b) => a - b);
    const parts = [];
    if (name) parts.push(`flood zone "${name}"`);
    if (iv.length) {
      parts.push(
        `inundated at the ${iv.join(", ")}-year flood` +
          (klima ? ", counting the 2100 climate projection" : "")
      );
    }
    return parts.length ? `Inside a ${parts.join("; ")}.` : "Inside a mapped flood zone.";
  }
  if (id === "landslide") {
    const isClay = hits.some((r) => /kvikkleire/i.test(r._svc || ""));
    const isSkred = hits.some((r) => /skredfaresoner/i.test(r._svc || ""));
    if (isClay && isSkred)
      return "Inside both a mapped quick-clay (kvikkleire) zone and a steep-terrain landslide zone. A geotechnical assessment is required here.";
    if (isClay)
      return "Inside a mapped quick-clay (kvikkleire) zone. A geotechnical assessment is required here.";
    return "Inside a mapped landslide hazard zone (steep-terrain skred).";
  }
  if (id === "snow") return "Inside a mapped snow-avalanche susceptibility area.";
  if (id === "rock") return "Inside a mapped rock-avalanche (fjellskred) zone. These zones can include tsunami run-out.";
  return "Inside a mapped hazard zone.";
}

// ---------------------------------------------------------------------------
// "How close is the nearest zone?"
//
// A bare "no mapped hazard here" hides the difference between a site in the
// middle of a plateau and one 30 m outside a flood line. For each hazard that
// misses, we find the distance to the nearest mapped polygon.
//
// One queryable polygon layer per check (same ids as the area route). Radon is
// absent on purpose: every square metre of Norway is inside some radon polygon,
// so "distance to the nearest one" is always zero and means nothing.
// ---------------------------------------------------------------------------
// Each check may span several services, and the distance has to span the same
// ones. Querying only Skredfaresoner3 for "landslide" reported "nothing within
// 5 km" at Brattora in Trondheim while 80 quick-clay polygons sat inside that
// radius, because quick clay lives in a separate service.
const NEAREST = {
  flood: [{ service: "Mapservices/FlomsoneKart2", layer: 22 }],
  landslide: [
    { service: "Skredfaresoner3", layer: 7 }, // Skredfaresone_1000
    { service: "Mapservices/SVV_kvikkleireomrade", layer: 1 }, // SVV_Kvikkleireomr
  ],
  snow: [{ service: "SnoskredAktsomhet", layer: 2 }],
  rock: [{ service: "Fjellskred1", layer: 8 }],
};
const NEAREST_SEARCH_KM = 5;

/** Distance from a point to a line segment, all in the same planar units. */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Ground distance (metres) to the nearest polygon of `spec` within
 * NEAREST_SEARCH_KM, or null if nothing is in range / the lookup failed.
 *
 * `maxAllowableOffset` is what makes this affordable: these polygons can carry
 * tens of thousands of vertices, and generalising to ~25 m turns a multi-MB
 * response into a few KB. The error it introduces is far below the precision we
 * report ("about 1.2 km").
 *
 * Distances are computed in web mercator and then multiplied by cos(lat),
 * because a mercator metre is shorter than a ground metre away from the equator
 * — at 60 degrees north, by a factor of two.
 */
async function nearestInLayer(spec, lng, lat) {
  try {
    const m = lngLatToMeters(lng, lat);
    // Search box in mercator units, so it covers NEAREST_SEARCH_KM on the ground.
    const d = (NEAREST_SEARCH_KM * 1000) / Math.cos((lat * Math.PI) / 180);
    const p = new URLSearchParams({
      geometry: `${m.x - d},${m.y - d},${m.x + d},${m.y + d}`,
      geometryType: "esriGeometryEnvelope",
      inSR: "3857",
      spatialRel: "esriSpatialRelIntersects",
      returnGeometry: "true",
      outSR: "3857",
      maxAllowableOffset: "25",
      resultRecordCount: "60",
      outFields: "",
      f: "json",
    });
    const r = await fetch(`${NVE}/${spec.service}/MapServer/${spec.layer}/query?${p.toString()}`, {
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    const feats = j.features || [];
    let best = Infinity;
    for (const f of feats) {
      const rings = (f.geometry && f.geometry.rings) || [];
      for (const ring of rings) {
        for (let i = 1; i < ring.length; i++) {
          const a = ring[i - 1];
          const b = ring[i];
          if (!isFinite(a[0]) || !isFinite(b[0])) continue;
          const dist = segDist(m.x, m.y, a[0], a[1], b[0], b[1]);
          if (dist < best) best = dist;
        }
      }
    }
    if (!isFinite(best)) return null;
    const ground = best * Math.cos((lat * Math.PI) / 180);
    return ground <= NEAREST_SEARCH_KM * 1000 ? ground : null;
  } catch {
    return null;
  }
}

/** Closest of several layers, or null when none has anything in range. */
async function nearestZoneM(specs, lng, lat) {
  const all = await Promise.all(specs.map((sp) => nearestInLayer(sp, lng, lat)));
  const found = all.filter((v) => v != null);
  return found.length ? Math.min(...found) : null;
}

/** "about 400 m away" / "about 2.3 km away" — rounded, never falsely precise. */
function nearestPhrase(metres) {
  if (metres == null) return `Nothing mapped within ${NEAREST_SEARCH_KM} km.`;
  if (metres < 950) return `The nearest mapped zone is about ${Math.max(10, Math.round(metres / 10) * 10)} m away.`;
  return `The nearest mapped zone is about ${(metres / 1000).toFixed(1)} km away.`;
}

// ---------------------------------------------------------------------------
// Storm surge and sea level rise (Kartverket).
//
// The scenario matters as much as the location: a site can sit above today's
// 200-year surge and below the same surge once 2100 sea level is added. The
// caller picks, and the answer names the scenario it used.
// ---------------------------------------------------------------------------
const KV_STORMFLO = "https://wms.geonorge.no/skwms1/wms.stormflo_havniva";

async function fetchSeaLevel(lng, lat, scenarioId) {
  const sc = seaScenario(scenarioId);
  const base = { id: "sea-level", label: "Storm surge & sea level" };
  try {
    const m = lngLatToMeters(lng, lat);
    const d = 60; // surge zones follow an elevation contour, so keep the probe tight
    const u =
      `${KV_STORMFLO}?service=WMS&version=1.3.0&request=GetFeatureInfo` +
      `&layers=${sc.id}&query_layers=${sc.id}&crs=EPSG:3857` +
      `&bbox=${m.x - d},${m.y - d},${m.x + d},${m.y + d}` +
      `&width=101&height=101&i=50&j=50&info_format=application/vnd.ogc.gml&feature_count=5`;
    const t = await (await fetch(u, { signal: AbortSignal.timeout(15000) })).text();
    const levels = [...t.matchAll(/<vannstandovernn2000>(-?\d+)<\/vannstandovernn2000>/g)].map((x) =>
      parseInt(x[1], 10)
    );
    if (!levels.length) {
      return {
        ...base,
        inZone: false,
        detail: `Above the ${sc.label.toLowerCase()} line at this point.`,
        severity: "none",
        scenario: sc.id,
        scenarioLabel: sc.label,
        note: sc.what,
      };
    }
    // vannstandovernn2000 is centimetres above the NN2000 height datum.
    const cm = Math.max(...levels);
    const cls = (t.match(/<sikkerhetsklasseflom>([^<]+)<\/sikkerhetsklasseflom>/) || [])[1];
    const clsBit = cls ? ` Kartverket files this zone under TEK17 flood safety class ${cls.trim()}.` : "";
    return {
      ...base,
      inZone: true,
      detail:
        `Inside the ${sc.label.toLowerCase()} zone. The water reaches ` +
        `${(cm / 100).toFixed(2)} m above NN2000 here.${clsBit}`,
      severity: "high",
      scenario: sc.id,
      scenarioLabel: sc.label,
      // NN2000 needs saying once a height is quoted, or the number is unreadable.
      note: `${sc.what} NN2000 is Norway's height reference, close to mean sea level.`,
      levelM: cm / 100,
      safetyClass: cls ? cls.trim() : null,
    };
  } catch {
    return {
      ...base,
      inZone: null,
      detail: "Lookup failed (Kartverket not reachable).",
      severity: "unknown",
      scenario: sc.id,
      scenarioLabel: sc.label,
      note: sc.what,
    };
  }
}

// ---- contextual (non-hazard-zone) info: weather, climate, earthquakes ----
function wmo(code) {
  const m = {
    0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "rime fog",
    51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
    66: "freezing rain", 67: "freezing rain", 71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
    80: "rain showers", 81: "rain showers", 82: "violent showers", 85: "snow showers", 86: "snow showers",
    95: "thunderstorm", 96: "thunderstorm w/ hail", 99: "thunderstorm w/ hail",
  };
  return m[code] || "unclear conditions";
}
async function fetchWeather(lng, lat) {
  try {
    // timezone=auto so the observation time is local to the site, not UTC —
    // a weather reading is meaningless without knowing when it was taken.
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,precipitation,wind_speed_10m,wind_gusts_10m,weather_code&wind_speed_unit=ms&timezone=auto`;
    const j = await (await fetch(u, { signal: AbortSignal.timeout(12000) })).json();
    const c = j.current;
    if (!c) return null;
    const rain = c.precipitation > 0 ? `, ${c.precipitation} mm/h now` : "";
    const gust = c.wind_gusts_10m != null ? ` (gusts ${Math.round(c.wind_gusts_10m)})` : "";
    const text = `${Math.round(c.temperature_2m)}°C, ${wmo(c.weather_code)}, wind ${Math.round(c.wind_speed_10m)}${gust} m/s${rain}.`;
    // c.time is local wall-clock ("2026-08-22T12:30") in j.timezone.
    let observedAt = null;
    if (c.time) {
      const [d, t] = String(c.time).split("T");
      observedAt = `${d} ${(t || "").slice(0, 5)}${j.timezone_abbreviation ? " " + j.timezone_abbreviation : ""}`;
    }
    return { text, observedAt, timezone: j.timezone || null };
  } catch {
    return null;
  }
}
async function fetchClimate(lng, lat) {
  try {
    const end = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const start = new Date(Date.now() - 370 * 86400000).toISOString().slice(0, 10);
    const u = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&start_date=${start}&end_date=${end}&daily=precipitation_sum`;
    const d = (await (await fetch(u, { signal: AbortSignal.timeout(15000) })).json()).daily;
    const vals = (d?.precipitation_sum || []).filter((x) => x != null);
    if (!vals.length) return null;
    const total = Math.round(vals.reduce((a, b) => a + b, 0));
    return `About ${total.toLocaleString("en-US")} mm of rain and snow.`;
  } catch {
    return null;
  }
}
/** "24 Aug 1995" reads faster than "1995-08-24" in prose. */
function fmtDay(ms) {
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toR = (x) => (x * Math.PI) / 180;
  const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
async function fetchQuakes(lng, lat, fromMs) {
  try {
    const startDate = new Date(fromMs).toISOString().slice(0, 10);
    // Phrase the window the same way the earthquake timeline does.
    const days = (Date.now() - fromMs) / 86400000;
    const since = days <= 400 ? "in the past 12 months" : `since ${new Date(fromMs).getFullYear()}`;
    const u = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=${lat}&longitude=${lng}&maxradiuskm=50&starttime=${startDate}&minmagnitude=2`;
    const f = (await (await fetch(u, { signal: AbortSignal.timeout(15000) })).json()).features || [];
    if (!f.length) return `Nothing of magnitude 2 or above within 50 km ${since}.`;
    // Report the MOST RECENT event (not the nearest): "has anything happened
    // here lately" is the question a reader actually has.
    let latest = null;
    for (const x of f) {
      const t = x.properties.time;
      if (!latest || t > latest.time) {
        const [lo, la] = x.geometry.coordinates;
        latest = { time: t, mag: x.properties.mag, km: haversineKm(lat, lng, la, lo) };
      }
    }
    const when = fmtDay(latest.time);
    return (
      `${f.length} of magnitude 2 or above within 50 km ${since}. ` +
      `The most recent was M${latest.mag}, ${Math.round(latest.km)} km away, on ${when}.`
    );
  } catch {
    return null;
  }
}

// The NGU class names are opaque unless you read Norwegian, so gloss them.
// Keys are matched loosely because the register is not perfectly consistent.
function radonGloss(besk) {
  const t = (besk || "").toLowerCase();
  if (t.includes("særlig")) return "particularly high";
  if (t.includes("høy")) return "high";
  if (t.includes("moderat")) return "moderate to low";
  if (t.includes("usikker")) return "uncertain, not surveyed in detail";
  return null;
}

// Radon: NGU WMS exposes GetFeatureInfo but not attributes, so we detect
// presence (a feature is returned only when the point is inside a radon
// susceptibility polygon). The class itself is visible via the map layer.
function lngLatToMeters(lng, lat) {
  const R = 6378137;
  return { x: (R * lng * Math.PI) / 180, y: R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) };
}
async function fetchRadon(lng, lat) {
  try {
    const m = lngLatToMeters(lng, lat);
    const d = 250;
    const bbox = `${m.x - d},${m.y - d},${m.x + d},${m.y + d}`;
    const u =
      `https://geo.ngu.no/mapserver/RadonWMS2?service=WMS&version=1.1.1&request=GetFeatureInfo` +
      `&layers=Radon_aktsomhet&query_layers=Radon_aktsomhet&srs=EPSG:3857&bbox=${bbox}` +
      `&width=101&height=101&x=50&y=50&info_format=application/vnd.ogc.gml`;
    const t = await (await fetch(u, { signal: AbortSignal.timeout(15000) })).text();
    // Every area gets a class: aktsomhetgrad 0=Usikker, 1=Moderat til lav,
    // 2=Høy, 3=Særlig høy. Only 2–3 (høy) are an actual radon concern — being
    // inside a "moderat til lav" (1) or "usikker" (0) polygon is NOT a hazard.
    const grads = [...t.matchAll(/<aktsomhetgrad>(\d+)<\/aktsomhetgrad>/g)].map((x) => parseInt(x[1], 10));
    const besks = [...t.matchAll(/<aktsomhetgrad_besk>([^<]+)<\/aktsomhetgrad_besk>/g)].map((x) => x[1].trim());
    if (!grads.length && !besks.length) {
      return { id: "radon", label: "Radon", inZone: false, detail: "No radon susceptibility mapped at this point.", severity: "none" };
    }
    const maxGrad = grads.length ? Math.max(...grads) : -1;
    const cls = besks[grads.indexOf(maxGrad)] || besks[0] || "unknown class";
    const elevated = maxGrad >= 2;
    return {
      id: "radon",
      label: "Radon",
      inZone: elevated,
      detail: elevated
        ? `Inside a "${cls}" area (${radonGloss(cls) || "elevated"}). Measure radon before building or buying.`
        : `${cls}${radonGloss(cls) ? ` (${radonGloss(cls)})` : ""}.`,
      severity: elevated ? "high" : "none",
    };
  } catch {
    return { id: "radon", label: "Radon", inZone: null, detail: "Lookup failed.", severity: "unknown" };
  }
}

// Which Norwegian municipality/county is this point in? Empty = outside Norway.
async function fetchCounty(lng, lat) {
  try {
    const k = await (
      await fetch(`https://api.kartverket.no/kommuneinfo/v1/punkt?nord=${lat}&ost=${lng}&koordsys=4326`, {
        signal: AbortSignal.timeout(12000),
      })
    ).json();
    return k && k.fylkesnavn ? { county: k.fylkesnavn, municipality: k.kommunenavn } : null;
  } catch {
    return null;
  }
}

// Live Varsom danger levels (flood + landslide) for an already-resolved county.
const LEVELS = { 1: "green", 2: "yellow", 3: "orange", 4: "red" };
async function fetchWarnings(lng, lat) {
  const here = await fetchCounty(lng, lat);
  const county = here && here.county;
  if (!county) return null; // kommuneinfo down or offshore — skip warnings (fail-open)
  try {
    const today = new Date().toISOString().slice(0, 10);
    const levelFor = async (kind, ver) => {
      try {
        const arr = await (
          await fetch(`https://api01.nve.no/hydrology/forecast/${kind}/${ver}/api/Warning/All/1/${today}/${today}`, {
            signal: AbortSignal.timeout(12000),
          })
        ).json();
        let lvl = 1;
        for (const w of arr || []) {
          const cs = w.CountyList || [];
          if (cs.some((c) => (c.Name || "").toLowerCase() === county.toLowerCase()))
            lvl = Math.max(lvl, parseInt(w.ActivityLevel) || 1);
        }
        return lvl;
      } catch {
        return null;
      }
    };
    const [flood, landslide] = await Promise.all([levelFor("flood", "v1.0.10"), levelFor("landslide", "v1.0.6")]);
    return { county, flood: flood ? LEVELS[flood] : null, landslide: landslide ? LEVELS[landslide] : null };
  } catch {
    return null;
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const lng = parseFloat(searchParams.get("lng"));
  const lat = parseFloat(searchParams.get("lat"));
  if (!isFinite(lng) || !isFinite(lat)) {
    return Response.json({ error: "lng and lat required" }, { status: 400 });
  }
  // Earthquake window start (epoch ms); defaults to the last 12 months.
  const fromMs = parseInt(searchParams.get("from"), 10) || Date.now() - 365 * 86400000;
  // Which storm-surge scenario to score against (see SEA_SCENARIOS).
  const seaId = searchParams.get("sea") || SEA_DEFAULT;

  // Gate: this map only has Norwegian data. Outside Norway → bail early.
  // Offline polygon check (no flaky external dependency).
  if (!inNorway(lng, lat)) {
    return Response.json({ lng, lat, outside: true });
  }

  const hazardsP = Promise.all(
    CHECKS.map(async (c) => {
      try {
        const perSvc = await Promise.all(
          c.services.map(async (s) => (await identify(s, lng, lat).catch(() => [])).map((r) => ({ ...r, _svc: s })))
        );
        const all = perSvc.flat();
        const named = (r) => String(r.layerName || "").trim();
        const hits = all.filter((r) => !COVERAGE_RE.test(named(r)) && (!c.zoneRe || c.zoneRe.test(named(r))));
        const inZone = hits.length > 0;
        if (inZone) {
          return { id: c.id, label: c.label, inZone: true, detail: detailFor(c.id, hits, all), severity: "high" };
        }
        // Clear of the zone — say how clear. Distance is what turns "not in a
        // flood zone" into something a buyer can act on.
        const specs = NEAREST[c.id];
        const nearestM = specs ? await nearestZoneM(specs, lng, lat) : null;
        // Dropping the buildings layer from the verdict should not drop the
        // signal. The two datasets genuinely disagree in places: at Drammen a
        // flood-exposed building sits within 50 m of a point whose nearest
        // mapped zone is 1.9 km away, so this is reported as its own fact rather
        // than folded into the distance.
        const exposed = c.id === "flood" && all.some((r) => /^Flomutsatte_bygg/i.test(named(r)));
        return {
          id: c.id,
          label: c.label,
          inZone: false,
          detail:
            `No mapped ${c.label.toLowerCase()} hazard at this point.` +
            (specs ? ` ${nearestPhrase(nearestM)}` : "") +
            (exposed
              ? " NVE separately records flood-exposed buildings at this spot, so the local flood study is worth reading even though no zone reaches it."
              : ""),
          severity: "none",
          nearestM,
          exposedBuildings: exposed || undefined,
        };
      } catch (e) {
        return { id: c.id, label: c.label, inZone: null, detail: "Lookup failed (NVE not reachable).", severity: "unknown" };
      }
    })
  );

  // Hazard checks (incl. radon) and contextual info all run in parallel.
  const [nveHazards, radon, sea, weather, climate, quakes, warnings] = await Promise.all([
    hazardsP,
    fetchRadon(lng, lat),
    fetchSeaLevel(lng, lat, seaId),
    fetchWeather(lng, lat),
    fetchClimate(lng, lat),
    fetchQuakes(lng, lat, fromMs),
    fetchWarnings(lng, lat),
  ]);

  const hazards = [...nveHazards, radon, sea];
  const hitCount = hazards.filter((h) => h.inZone === true).length;
  return Response.json({
    lng,
    lat,
    hazards,
    overall: hitCount > 0 ? "at-risk" : "clear",
    hitCount,
    warnings,
    context: { weather, climate, quakes },
  });
}
