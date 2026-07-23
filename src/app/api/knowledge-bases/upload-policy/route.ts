import { toDocumentUploadPolicy } from "@/lib/document-upload-policy"
import { serverConfig } from "@/server/config"

export const dynamic = "force-dynamic"

export function GET() {
  return Response.json({
    policy: toDocumentUploadPolicy(serverConfig.upload),
  })
}
