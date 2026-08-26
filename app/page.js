"use client";

import dynamic from "next/dynamic";

// MapLibre touches `window`, so load the map only on the client.
const HazardMap = dynamic(() => import("../components/HazardMap"), {
  ssr: false,
  loading: () => <div className="loading">Loading map…</div>,
});

export default function Page() {
  return <HazardMap />;
}
