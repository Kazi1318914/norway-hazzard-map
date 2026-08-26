// Server-side map compositor for the PDF reports.
//
// WHY THIS EXISTS: the reports used to build their map as a stack of
// absolutely-positioned cross-origin <img>s plus CSS decor (a translucent,
// border-radius'd, transform'd circle). Chrome's print rasterizer promotes such
// an element to its own composited layer and can rasterize it WITHOUT its
// backdrop — the layer's white backing then paints over the map, producing a
// white disc in the saved PDF while the same page looks fine on screen.
//
// So we flatten everything here instead: base map + hazard overlays + ring +
// pin are composited into ONE fully-opaque PNG. The report then contains a
// single static bitmap — no transparency, no transforms, no stacking contexts,
// and (once inlined as a data: URI by the client) no network at print time.

import { PNG } from "pngjs";
import { HAZARD_LAYERS } from "../../../lib/layers";

export const runtime = "nodejs"; // pngjs needs zlib + Buffer
export const dynamic = "force-dynamic"; // reads searchParams

const BASE_WMS = "https://wms.geonorge.no/skwms1/wms.topograatone";
const NO_DATA = [0xee, 0xf2, 0xf7]; // matches the old .mapwrap background
const RING_COLOR = [0x25, 0x63, 0xeb];
const PIN_FILL = [0xdc, 0x26, 0x26];
const PIN_EDGE = [0xb9, 0x1d, 0x1d];

function toMerc3857(lng, lat) {
  const R = 6378137;
  return { x: (R * lng * Math.PI) / 180, y: R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Fetch + decode a PNG. Throws on anything that isn't a usable RGBA raster. */
async function fetchPng(url, ms) {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`http ${res.status}`);
  // ArcGIS `export?f=image` answers 200 with a JSON/HTML error body on bad
  // params, so the content type — not the status — is the real gate.
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("image/png")) throw new Error(`not a png: ${ct}`);
  const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
  if (png.data.length !== png.width * png.height * 4) throw new Error("unexpected raster shape");
  return png;
}

/** Rewrite a HAZARD_LAYERS tile template to the size we need. */
function overlayUrl(lyr, bbox, S) {
  const u = new URL(lyr.tiles.replace("{bbox-epsg-3857}", bbox));
  if (u.searchParams.has("size")) u.searchParams.set("size", `${S},${S}`); // NVE ArcGIS
  if (u.searchParams.has("width")) u.searchParams.set("width", String(S)); // NGU WMS
  if (u.searchParams.has("height")) u.searchParams.set("height", String(S));
  return u.toString();
}

/**
 * Source-over composite of `src` onto `dst`, nearest-neighbour sampled.
 * Nearest-neighbour is the correct choice here rather than a shortcut: these
 * are flat-colour categorical hazard polygons, and bilinear would blend their
 * colours against transparent pixels and ring every polygon with a halo.
 */
function compositeOver(dst, dw, dh, src, sw, sh, alphaMul) {
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw));
      const si = (sy * sw + sx) * 4;
      const a = (src[si + 3] / 255) * alphaMul;
      if (a <= 0) continue;
      const di = (y * dw + x) * 4;
      dst[di] = src[si] * a + dst[di] * (1 - a);
      dst[di + 1] = src[si + 1] * a + dst[di + 1] * (1 - a);
      dst[di + 2] = src[si + 2] * a + dst[di + 2] * (1 - a);
      dst[di + 3] = 255;
    }
  }
}

/** Blend a colour into one pixel at the given coverage (0..1). */
function blendPx(data, S, x, y, rgb, cov) {
  if (cov <= 0 || x < 0 || y < 0 || x >= S || y >= S) return;
  const a = cov > 1 ? 1 : cov;
  const i = (y * S + x) * 4;
  data[i] = rgb[0] * a + data[i] * (1 - a);
  data[i + 1] = rgb[1] * a + data[i + 1] * (1 - a);
  data[i + 2] = rgb[2] * a + data[i + 2] * (1 - a);
  data[i + 3] = 255;
}

/**
 * Dashed ring, anti-aliased. `ringFrac` is the ring DIAMETER as a fraction of
 * the image width, matching the old CSS `circleFrac`.
 */
function drawRing(data, S, ringFrac, width) {
  const c = S / 2;
  const r = (ringFrac * S) / 2;
  if (r <= 1) return;
  const halfW = width / 2;
  const period = Math.max(10, Math.round(18 * (S / 640))); // dash cadence ~ CSS [2,1]
  const onLen = period * 0.62;
  const yLo = Math.max(0, Math.floor(c - r - halfW - 2));
  const yHi = Math.min(S - 1, Math.ceil(c + r + halfW + 2));
  for (let y = yLo; y <= yHi; y++) {
    const dy = y + 0.5 - c;
    for (let x = 0; x < S; x++) {
      const dx = x + 0.5 - c;
      const band = Math.abs(Math.hypot(dx, dy) - r);
      if (band > halfW + 1) continue;
      // arc position -> dash on/off
      const arc = Math.atan2(dy, dx) * r;
      if (((arc % period) + period) % period > onLen) continue;
      blendPx(data, S, x, y, RING_COLOR, halfW + 0.5 - band);
    }
  }
}

/** Filled AA disc. */
function disc(data, S, cx, cy, r, rgb) {
  for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
    for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      blendPx(data, S, x, y, rgb, r + 0.5 - d);
    }
  }
}

/** Centre marker: white halo, red core, dark rim. Scaled up from the tiny CSS dot. */
function drawPin(data, S) {
  const c = S / 2;
  const k = S / 640;
  const rOuter = 9 * k;
  disc(data, S, c, c, rOuter, [255, 255, 255]);
  disc(data, S, c, c, 6 * k, PIN_FILL);
  // 1px-ish rim on the white halo
  for (let y = Math.floor(c - rOuter - 2); y <= Math.ceil(c + rOuter + 2); y++) {
    for (let x = Math.floor(c - rOuter - 2); x <= Math.ceil(c + rOuter + 2); x++) {
      const band = Math.abs(Math.hypot(x + 0.5 - c, y + 0.5 - c) - rOuter);
      if (band > 1.2) continue;
      blendPx(data, S, x, y, PIN_EDGE, 1.0 - band);
    }
  }
}

export async function GET(request) {
  const q = new URL(request.url).searchParams;

  const lng = parseFloat(q.get("lng"));
  const lat = parseFloat(q.get("lat"));
  if (!isFinite(lng) || !isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 85) {
    return Response.json({ error: "valid lng/lat required" }, { status: 400 });
  }
  const half = clamp(parseFloat(q.get("half")) || 6000, 100, 2_000_000);
  const S = clamp(parseInt(q.get("size"), 10) || 768, 256, 1280);
  const ring = parseFloat(q.get("ring"));
  const pin = q.get("pin") === "1";

  // Resolve overlay ids against our own layer list — never accept a URL, or
  // this endpoint becomes an open image proxy (SSRF).
  const ids = (q.get("overlays") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const layers = ids.map((id) => HAZARD_LAYERS.find((l) => l.id === id)).filter(Boolean).slice(0, 4);

  const m = toMerc3857(lng, lat);
  const bbox = `${m.x - half},${m.y - half},${m.x + half},${m.y + half}`;

  // 1. Base map. If this fails there is no report map worth showing.
  const baseUrl =
    `${BASE_WMS}?service=WMS&version=1.3.0&request=GetMap&layers=topograatone&styles=` +
    `&crs=EPSG:3857&bbox=${bbox}&width=${S}&height=${S}&format=image/png`;
  let out;
  try {
    out = await fetchPng(baseUrl, 15000);
  } catch (e) {
    return Response.json({ error: "base map unavailable", detail: String(e.message || e) }, { status: 502 });
  }

  // 2. Force full opacity: any transparent base pixel becomes the no-data grey.
  //    From here on every pixel is opaque, so nothing downstream can composite
  //    wrong — this is the property that makes the print bug impossible.
  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i + 3] < 255) {
      const a = out.data[i + 3] / 255;
      out.data[i] = out.data[i] * a + NO_DATA[0] * (1 - a);
      out.data[i + 1] = out.data[i + 1] * a + NO_DATA[1] * (1 - a);
      out.data[i + 2] = out.data[i + 2] * a + NO_DATA[2] * (1 - a);
      out.data[i + 3] = 255;
    }
  }

  // 3. Overlays are decorative: a slow or broken one must never fail the report.
  const dropped = [];
  if (layers.length) {
    const settled = await Promise.allSettled(layers.map((l) => fetchPng(overlayUrl(l, bbox, S), 12000)));
    settled.forEach((r, idx) => {
      if (r.status === "fulfilled") {
        compositeOver(out.data, out.width, out.height, r.value.data, r.value.width, r.value.height, 0.75);
      } else {
        dropped.push(layers[idx].id);
      }
    });
  }

  // 4. Decor, drawn straight into the pixels.
  if (isFinite(ring) && ring > 0 && ring <= 1) drawRing(out.data, S, ring, Math.max(2, 2.5 * (S / 640)));
  if (pin) drawPin(out.data, S);

  // colorType 2 (RGB, no alpha): ~15% smaller and structurally guarantees the
  // output cannot carry transparency.
  const buf = PNG.sync.write(out, {
    colorType: 2,
    inputColorType: 6,
    inputHasAlpha: true,
    deflateLevel: 9,
  });

  const headers = {
    "Content-Type": "image/png",
    "Content-Length": String(buf.length),
    "Cache-Control": "public, max-age=3600, s-maxage=86400",
  };
  if (dropped.length) headers["X-Overlays-Dropped"] = dropped.join(",");
  return new Response(buf, { headers });
}
