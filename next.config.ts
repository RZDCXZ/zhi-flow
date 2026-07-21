import type { NextConfig } from "next"

import { loadServerConfig } from "./src/server/config-definition"

loadServerConfig()

const nextConfig: NextConfig = {}

export default nextConfig
