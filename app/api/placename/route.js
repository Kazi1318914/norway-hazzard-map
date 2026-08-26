// Reverse geocode a point to the nearest meaningful Norwegian place name, so
// report captions can say "near Fretheim" instead of "near 60.8566, 7.1140".
//
// Kartverket's stedsnavn register is extremely granular — the closest name to
// any given point is often a single boulder or knoll ("Vatnasteinane", type
// Stein). So we rank by feature TYPE first (settlements > farms > landforms)
// and only then by distance; picking purely by distance yields useless labels.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Best first. Anything not listed ranks last but is still usable as a fallback.
const TYPE_RANK = [
  "By",
  "Tettbebyggelse",
  "Tettsted",
  "Bygd",
  "Grend",
  "Boligfelt",
  "Gard",
  "Bruk",
  "Dal",
  "Fjord",
  "Vik",
  "Nes",
  "Fjell",
  "Li",
  "Haug",
  "Vatn",
  "Innsjø",
  "Elv",
];

/** Municipality for a point, or null. Adds "…, Aurland" context to a bare name. */
async function municipalityOf(lat, lng) {
  try {
    const r = await fetch(
      `https://api.kartverket.no/kommuneinfo/v1/punkt?nord=${lat}&ost=${lng}&koordsys=4326`,
      { cache: "no-store", signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) return null;
    const k = await r.json();
    return k && k.kommunenavn ? k.kommunenavn : null;
  } catch {
    return null;
  }
}

export async function GET(request) {
  const q = new URL(request.url).searchParams;
  const lat = parseFloat(q.get("lat"));
  const lng = parseFloat(q.get("lng"));
  if (!isFinite(lat) || !isFinite(lng)) {
    return Response.json({ error: "valid lat/lng required" }, { status: 400 });
  }

  try {
    const u =
      "https://api.kartverket.no/stedsnavn/v1/punkt?" +
      new URLSearchParams({
        nord: String(lat),
        ost: String(lng),
        koordsys: "4258", // ETRS89 geographic — what stedsnavn expects for lat/lon
        radius: "4000",
        treffPerSide: "50",
      }).toString();
    const [res, municipality] = await Promise.all([
      fetch(u, { cache: "no-store", signal: AbortSignal.timeout(12000) }),
      municipalityOf(lat, lng),
    ]);
    if (!res.ok) return Response.json({ name: null, municipality }, { status: 200 });
    const d = await res.json();

    let best = null;
    for (const n of d.navn || []) {
      const name = ((n.stedsnavn || [])[0] || {}).skrivemåte;
      if (!name) continue;
      const type = n.navneobjekttype || "";
      const rankIdx = TYPE_RANK.indexOf(type);
      const cand = {
        name,
        type,
        distanceM: Math.round(n.meterFraPunkt ?? 0),
        rank: rankIdx === -1 ? 99 : rankIdx,
      };
      if (!best || cand.rank < best.rank || (cand.rank === best.rank && cand.distanceM < best.distanceM)) {
        best = cand;
      }
    }
    if (!best) return Response.json({ name: null, municipality });
    return Response.json(
      { name: best.name, type: best.type, distanceM: best.distanceM, municipality },
      { headers: { "Cache-Control": "public, max-age=86400" } }
    );
  } catch {
    // Never fail the caller — captions fall back to coordinates.
    return Response.json({ name: null });
  }
}
