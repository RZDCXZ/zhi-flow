import {
  deleteKnowledgeBase,
  readKnowledgeBase,
  renameKnowledgeBase,
} from "@/server/knowledge-bases"

import { dataError, invalidName, readName } from "../route"

type RouteContext = Readonly<{
  params: Promise<{ knowledgeBaseId: string }>
}>

export async function GET(_request: Request, context: RouteContext) {
  const { knowledgeBaseId } = await context.params
  try {
    const result = await readKnowledgeBase(knowledgeBaseId)
    return result === null ? notFound() : Response.json(result)
  } catch {
    return dataError()
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const name = await readName(request)
  if (name === null) return invalidName()
  const { knowledgeBaseId } = await context.params

  try {
    const knowledgeBase = await renameKnowledgeBase(knowledgeBaseId, name)
    return knowledgeBase === null
      ? notFound()
      : Response.json({ knowledgeBase })
  } catch {
    return dataError()
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const confirmation = await readConfirmation(request)
  if (confirmation === null) return invalidConfirmation()
  const { knowledgeBaseId } = await context.params

  try {
    const result = await readKnowledgeBase(knowledgeBaseId)
    if (result === null) return notFound()
    if (result.knowledgeBase.name !== confirmation) return invalidConfirmation()
    return (await deleteKnowledgeBase(knowledgeBaseId))
      ? new Response(null, { status: 204 })
      : notFound()
  } catch {
    return dataError()
  }
}

async function readConfirmation(request: Request): Promise<string | null> {
  try {
    const body: unknown = await request.json()
    if (
      typeof body !== "object" ||
      body === null ||
      !("confirmation" in body) ||
      typeof body.confirmation !== "string" ||
      !body.confirmation.trim()
    ) {
      return null
    }
    return body.confirmation.trim()
  } catch {
    return null
  }
}

function invalidConfirmation() {
  return Response.json(
    {
      error: {
        code: "CONFIRMATION_REQUIRED",
        message: "请输入完整知识库名称以确认删除。",
      },
    },
    { status: 400 },
  )
}

function notFound() {
  return Response.json(
    { error: { code: "NOT_FOUND", message: "知识库不存在。" } },
    { status: 404 },
  )
}
