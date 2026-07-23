import { assistantMessageGeneration } from "@/server/composition-root"
import {
  deleteConversation,
  readConversation,
  renameConversation,
} from "@/server/conversations"

import { dataError, invalidTitle, readTitle } from "../route"

type RouteContext = Readonly<{
  params: Promise<{ conversationId: string }>
}>

export async function GET(_request: Request, context: RouteContext) {
  const { conversationId } = await context.params
  try {
    const recovery =
      await assistantMessageGeneration.recoverStaleGenerations(conversationId)
    if (recovery.type === "unavailable") return dataError()
    const result = await readConversation(conversationId)
    return result === null ? notFound() : Response.json(result)
  } catch {
    return dataError()
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const title = await readTitle(request)
  if (title === null) return invalidTitle()
  const { conversationId } = await context.params

  try {
    const conversation = await renameConversation(conversationId, title)
    return conversation === null ? notFound() : Response.json({ conversation })
  } catch {
    return dataError()
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { conversationId } = await context.params
  try {
    return (await deleteConversation(conversationId))
      ? new Response(null, { status: 204 })
      : notFound()
  } catch {
    return dataError()
  }
}

function notFound() {
  return Response.json(
    { error: { code: "NOT_FOUND", message: "会话不存在。" } },
    { status: 404 },
  )
}
