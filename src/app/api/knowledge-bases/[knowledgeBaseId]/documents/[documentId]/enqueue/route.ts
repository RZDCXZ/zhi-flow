import { enqueueDocumentIngestion } from "@/server/documents/document-ingestion-queue"
import { readKnowledgeBase } from "@/server/knowledge-bases"

type RouteContext = Readonly<{
  params: Promise<{ knowledgeBaseId: string; documentId: string }>
}>

export async function POST(_request: Request, context: RouteContext) {
  const { knowledgeBaseId, documentId } = await context.params

  try {
    const knowledgeBase = await readKnowledgeBase(knowledgeBaseId)
    const existingDocument = knowledgeBase?.documents.find(
      (document) => document.id === documentId,
    )
    if (existingDocument === undefined) return notFound()

    const enqueueResult = await enqueueDocumentIngestion(documentId)
    if (enqueueResult.outcome === "queue_write_failed") {
      return Response.json(
        {
          document: enqueueResult.document,
          error: {
            code: "QUEUE_WRITE_FAILED",
            message: enqueueResult.document.errorSummary,
          },
        },
        { status: 503 },
      )
    }
    if (enqueueResult.outcome === "ineligible") {
      return Response.json(
        {
          document: enqueueResult.document,
          error: {
            code: "REQUEUE_NOT_ALLOWED",
            message: "当前 Document 状态不能重新入队。",
          },
        },
        { status: 409 },
      )
    }
    return Response.json({ document: enqueueResult.document })
  } catch {
    return Response.json(
      {
        error: {
          code: "QUEUE_UNAVAILABLE",
          message: "摄取队列暂时不可用，请稍后重试。",
        },
      },
      { status: 503 },
    )
  }
}

function notFound() {
  return Response.json(
    { error: { code: "NOT_FOUND", message: "Document 不存在。" } },
    { status: 404 },
  )
}
