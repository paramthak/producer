import type { NextConfig } from "next";

const config: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "2gb",
    },
  },
  // @resvg/resvg-js loads a native .node binary (platform-specific package
  // @resvg/resvg-js-darwin-arm64 etc.) the bundler can't resolve — keep it
  // external so it's required at runtime, same as @google/genai.
  serverExternalPackages: ["@google/genai", "@resvg/resvg-js"],
};

export default config;
