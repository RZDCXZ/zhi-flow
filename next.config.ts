import type { NextConfig } from "next"

import { loadServerConfig } from "./src/server/config-definition"

loadServerConfig()

const testTsconfigPath = process.env.ZHI_FLOW_NEXT_TSCONFIG_PATH?.trim()
const nextConfig: NextConfig = {
  distDir: process.env.ZHI_FLOW_NEXT_DIST_DIR?.trim() || ".next",
  ...(testTsconfigPath
    ? { typescript: { tsconfigPath: testTsconfigPath } }
    : {}),
}

export default nextConfig
