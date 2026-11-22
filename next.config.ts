import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Work around a Next.js 15 webpack minifier crash during Vercel production builds.
  experimental: {
    serverMinification: false,
  },
  // Playwright is loaded lazily on the server and must not be bundled.
  serverExternalPackages: ["playwright", "playwright-core"],
};

export default nextConfig;
