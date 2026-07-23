import {
  DocumentUploadError,
  uploadDocuments,
} from "@/server/documents/document-upload"
import { readKnowledgeBase } from "@/server/knowledge-bases"

type RouteContext = Readonly<{
  params: Promise<{ knowledgeBaseId: string }>
}>

export async function POST(request: Request, context: RouteContext) {
  const { knowledgeBaseId } = await context.params

  try {
    if ((await readKnowledgeBase(knowledgeBaseId)) === null) return notFound()
    const form = await request.formData()
    const files = form
      .getAll("files")
      .filter((value): value is File => value instanceof File)
    if (files.length === 0) return invalidFiles()

    const documents = await uploadDocuments(knowledgeBaseId, files)
    return Response.json({ documents }, { status: 201 })
  } catch (error) {
    if (error instanceof DocumentUploadError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: 400 },
      )
    }
    return Response.json(
      {
        error: {
          code: "UPLOAD_UNAVAILABLE",
          message: "上传服务暂时不可用，请稍后重试。",
        },
      },
      { status: 503 },
    )
  }
}

function invalidFiles() {
  return Response.json(
    { error: { code: "INVALID_INPUT", message: "请选择要上传的文件。" } },
    { status: 400 },
  )
}

function notFound() {
  return Response.json(
    { error: { code: "NOT_FOUND", message: "知识库不存在。" } },
    { status: 404 },
  )
}
