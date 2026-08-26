/** @type {import('next').NextConfig} */
const nextConfig = {
  // Strict Mode double-mounts effects in dev, which makes MapLibre create →
  // destroy → recreate the map and can leave a blank canvas. Off for stability.
  reactStrictMode: false,
};

export default nextConfig;
