import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Playwright is loaded lazily on the server and must not be bundled.
  serverExternalPackages: ["playwright", "playwright-core"],
};

export default nextConfig;
