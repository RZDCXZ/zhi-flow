import {
  createKnowledgeBase,
  listKnowledgeBases,
} from "@/server/knowledge-bases"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return Response.json({ knowledgeBases: await listKnowledgeBases() })
  } catch {
    return dataError()
  }
}

export async function POST(request: Request) {
  const name = await readName(request)
  if (name === null) return invalidName()

  try {
    const knowledgeBase = await createKnowledgeBase(name)
    return Response.json(
      { knowledgeBase },
      {
        status: 201,
        headers: { Location: `/api/knowledge-bases/${knowledgeBase.id}` },
      },
    )
  } catch {
    return dataError()
  }
}

export async function readName(request: Request): Promise<string | null> {
  try {
    const body: unknown = await request.json()
    if (
      typeof body !== "object" ||
      body === null ||
      !("name" in body) ||
      typeof body.name !== "string" ||
      !body.name.trim()
    ) {
      return null
    }
    return body.name.trim()
  } catch {
    return null
  }
}

export function invalidName() {
  return Response.json(
    { error: { code: "INVALID_INPUT", message: "请输入知识库名称。" } },
    { status: 400 },
  )
}

export function dataError() {
  return Response.json(
    { error: { code: "DATA_UNAVAILABLE", message: "暂时无法访问知识库。" } },
    { status: 503 },
  )
}
