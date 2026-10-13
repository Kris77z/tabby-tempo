import type { NextConfig } from "next";
const config: NextConfig = {
  // Keep the accepted demo build intact while validating the expanded Arena.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false, reactStrictMode: true, transpilePackages: ["@agentfuel/sdk", "@agentfuel/arena"],
  // Workspace services use Node ESM .js specifiers over TypeScript source.
  // Resolve their source generically, while retaining real .js files in dependencies.
  webpack: webpackConfig => {
    webpackConfig.resolve.extensionAlias = { ...webpackConfig.resolve.extensionAlias,
      ".js": [".js", ".ts", ".tsx"], ".mjs": [".mjs", ".mts"], ".cjs": [".cjs", ".cts"] };
    return webpackConfig;
  },
};
export default config;
