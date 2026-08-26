// Returns a ready-to-use raster tile URL template for the latest precipitation
// radar frame from RainViewer (free, no API key). RainViewer publishes a
// manifest whose frame `path` rotates over time, so we resolve it at runtime.

export const dynamic = "force-dynamic"; // never cache — radar moves

export async function GET() {
  try {
    const res = await fetch("https://api.rainviewer.com/public/weather-maps.json", {
      signal: AbortSignal.timeout(10000),
    });
    const d = await res.json();
    const host = d.host;
    const past = (d.radar && d.radar.past) || [];
    const nowcast = (d.radar && d.radar.nowcast) || [];
    const all = [...past, ...nowcast];
    const latest = past[past.length - 1] || nowcast[0];
    if (!host || !latest) {
      return Response.json({ error: "no radar frame available" }, { status: 502 });
    }
    // {host}{path}/{size}/{z}/{x}/{y}/{color}/{smooth}_{snow}.png
    // color 4 = "The Weather Channel" palette; 1_1 = smoothed, show snow.
    const toUrl = (f) => `${host}${f.path}/256/{z}/{x}/{y}/4/1_1.png`;
    const frames = all.map((f) => ({ tileUrl: toUrl(f), time: f.time }));
    return Response.json({ tileUrl: toUrl(latest), time: latest.time, frames });
  } catch (e) {
    return Response.json({ error: "weather service unavailable" }, { status: 502 });
  }
}
