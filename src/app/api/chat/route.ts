import { OpenAiCompatibleChatProvider } from "@/server/chat/openai-compatible-chat-provider"
import {
  ChatProviderError,
  type ChatProviderErrorKind,
} from "@/server/chat/chat-provider"
import { serverConfig } from "@/server/config"
import { MAX_CHAT_MESSAGE_LENGTH, type ChatErrorResponse } from "@/lib/chat-api"

export const dynamic = "force-dynamic"

const chatProvider = new OpenAiCompatibleChatProvider(serverConfig.chat)

type ChatErrorDefinition = ChatErrorResponse["error"] &
  Readonly<{ status: number }>

const invalidInputError = {
  status: 400,
  code: "INVALID_INPUT",
  message: "请输入消息。",
  retryable: false,
} satisfies ChatErrorDefinition

const providerUnavailableError = {
  status: 502,
  code: "PROVIDER_UNAVAILABLE",
  message: "聊天服务暂时不可用，请稍后重试。",
  retryable: true,
} satisfies ChatErrorDefinition

const providerErrors = {
  authentication: {
    status: 502,
    code: "PROVIDER_AUTHENTICATION_FAILED",
    message: "聊天服务配置异常，请稍后再试。",
    retryable: false,
  },
  rate_limit: {
    status: 429,
    code: "RATE_LIMITED",
    message: "请求过于频繁，请稍后重试。",
    retryable: true,
  },
  unavailable: providerUnavailableError,
  invalid_response: providerUnavailableError,
  timeout: {
    status: 504,
    code: "PROVIDER_TIMEOUT",
    message: "聊天服务响应超时，请重试。",
    retryable: true,
  },
} satisfies Record<ChatProviderErrorKind, ChatErrorDefinition>

const internalError = {
  status: 500,
  code: "INTERNAL_ERROR",
  message: "聊天服务暂时不可用，请稍后再试。",
  retryable: true,
} satisfies ChatErrorDefinition

export async function POST(request: Request) {
  const body = await readRequestBody(request)
  if (body === null || !body.message.trim()) {
    return chatError(invalidInputError)
  }

  const message = body.message.trim()
  if ([...message].length > MAX_CHAT_MESSAGE_LENGTH) {
    return chatError({
      status: 400,
      code: "INPUT_TOO_LONG",
      message: `消息不能超过 ${MAX_CHAT_MESSAGE_LENGTH} 个字符。`,
      retryable: false,
    })
  }

  const startedAt = performance.now()
  let completion
  try {
    completion = await chatProvider.complete({ message })
  } catch (error) {
    if (error instanceof ChatProviderError) {
      return chatError(providerErrors[error.kind])
    }
    return chatError(internalError)
  }

  return Response.json(
    {
      answer: completion.answer,
      latencyMs: Math.round(performance.now() - startedAt),
      usage: completion.usage,
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  )
}

async function readRequestBody(
  request: Request,
): Promise<{ message: string } | null> {
  try {
    const body: unknown = await request.json()
    if (
      typeof body !== "object" ||
      body === null ||
      !("message" in body) ||
      typeof body.message !== "string"
    ) {
      return null
    }
    return { message: body.message }
  } catch {
    return null
  }
}

function chatError({ status, ...error }: ChatErrorDefinition) {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  )
}
