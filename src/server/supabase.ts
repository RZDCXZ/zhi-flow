import "server-only"

import { createClient } from "@supabase/supabase-js"

import { serverConfig } from "./config"

export function createServerDataClient() {
  return createClient(
    serverConfig.supabase.url,
    serverConfig.supabase.secretKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  )
}
