import type { NextConfig } from "next";

const config: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "2gb",
    },
  },
  serverExternalPackages: ["@google/genai"],
};

export default config;
