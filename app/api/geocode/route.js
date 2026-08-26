// Address search proxy for Kartverket's free open address API (no key).
// Browser calls /api/geocode?q=... → simplified [{text, place, lat, lon}].

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") || "").trim();
  if (q.length < 3) return Response.json({ results: [] });

  try {
    const url =
      "https://ws.geonorge.no/adresser/v1/sok?" +
      new URLSearchParams({ sok: q, treffPerSide: "6", fuzzy: "true" }).toString();
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const d = await res.json();
    const results = (d.adresser || [])
      .map((a) => ({
        text: a.adressetekst,
        place: a.poststed,
        lat: a.representasjonspunkt && a.representasjonspunkt.lat,
        lon: a.representasjonspunkt && a.representasjonspunkt.lon,
      }))
      .filter((r) => typeof r.lat === "number" && typeof r.lon === "number");
    return Response.json({ results });
  } catch (e) {
    return Response.json({ results: [], error: true }, { status: 502 });
  }
}
