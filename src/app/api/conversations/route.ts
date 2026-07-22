import { createConversation, listConversations } from "@/server/conversations"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return Response.json({ conversations: await listConversations() })
  } catch {
    return dataError()
  }
}

export async function POST(request: Request) {
  const title = await readTitle(request)
  if (title === null) return invalidTitle()

  try {
    const conversation = await createConversation(title)
    return Response.json(
      { conversation },
      {
        status: 201,
        headers: { Location: `/api/conversations/${conversation.id}` },
      },
    )
  } catch {
    return dataError()
  }
}

async function readTitle(request: Request): Promise<string | null> {
  try {
    const body: unknown = await request.json()
    if (
      typeof body !== "object" ||
      body === null ||
      !("title" in body) ||
      typeof body.title !== "string" ||
      !body.title.trim()
    ) {
      return null
    }
    return body.title.trim()
  } catch {
    return null
  }
}

function invalidTitle() {
  return Response.json(
    { error: { code: "INVALID_INPUT", message: "请输入会话标题。" } },
    { status: 400 },
  )
}

function dataError() {
  return Response.json(
    { error: { code: "DATA_UNAVAILABLE", message: "暂时无法访问会话。" } },
    { status: 503 },
  )
}

export { dataError, invalidTitle, readTitle }
