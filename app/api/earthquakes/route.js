// Earthquakes near Norway from the USGS FDSN catalog (free, no key).
// Returns GeoJSON (only features with a numeric magnitude) for direct use as a
// MapLibre geojson source. Bounded to the Nordic region.

export const revalidate = 3600; // cache for an hour

export async function GET() {
  try {
    const url =
      "https://earthquake.usgs.gov/fdsnws/event/1/query?" +
      new URLSearchParams({
        format: "geojson",
        minlatitude: "56",
        maxlatitude: "72",
        minlongitude: "0",
        maxlongitude: "33",
        starttime: "1990-01-01",
        minmagnitude: "2",
        orderby: "time",
        limit: "20000",
      }).toString();

    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const geo = await res.json();
    const features = (geo.features || []).filter(
      (f) => f.properties && typeof f.properties.mag === "number"
    );
    return Response.json({ type: "FeatureCollection", features });
  } catch (e) {
    return Response.json({ type: "FeatureCollection", features: [] }, { status: 502 });
  }
}
