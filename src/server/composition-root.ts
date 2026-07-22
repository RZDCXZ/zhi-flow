import "server-only"

import { AssistantMessageGenerationModule } from "@/server/chat/assistant-message-generation"
import { OpenAiCompatibleChatProvider } from "@/server/chat/openai-compatible-chat-provider"

import { serverConfig } from "./config"

const chatProvider = new OpenAiCompatibleChatProvider(serverConfig.chat)

export const assistantMessageGeneration = new AssistantMessageGenerationModule(
  chatProvider,
  serverConfig.chat,
)
