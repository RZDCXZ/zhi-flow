insert into public.knowledge_bases (id, name)
values (
  '30000000-0000-0000-0000-000000000001',
  'Zhi Flow 入门知识库'
);

insert into public.documents (
  id,
  knowledge_base_id,
  original_filename,
  storage_object_key,
  mime_type,
  byte_size,
  page_count,
  sha256,
  status,
  current_stage
)
values (
  '30000000-0000-0000-0000-000000000010',
  '30000000-0000-0000-0000-000000000001',
  'zhi-flow-introduction.md',
  'seed/zhi-flow-introduction.md',
  'text/markdown',
  512,
  1,
  repeat('3', 64),
  'ready',
  'completed'
);

insert into public.document_chunks (
  id,
  document_id,
  knowledge_base_id,
  document_version,
  chunking_version,
  chunk_index,
  content,
  estimated_token_count,
  page_start,
  page_end,
  heading_path,
  source_locator,
  embedding_model,
  embedding
)
values (
  '30000000-0000-0000-0000-000000000020',
  '30000000-0000-0000-0000-000000000010',
  '30000000-0000-0000-0000-000000000001',
  1,
  'structure-v1',
  0,
  'Zhi Flow 通过按里程碑推进的方式学习 AI 聊天与 RAG。',
  24,
  1,
  1,
  array['Zhi Flow 简介'],
  'zhi-flow-introduction.md#zhi-flow-简介',
  'BAAI/bge-m3',
  array_fill(0::real, array[1024])::extensions.vector
);

insert into public.conversations (
  id,
  title,
  mode,
  knowledge_base_id
)
values (
  '30000000-0000-0000-0000-000000000030',
  '认识 Zhi Flow',
  'knowledge_base',
  '30000000-0000-0000-0000-000000000001'
);

insert into public.messages (
  id,
  conversation_id,
  role,
  content,
  status,
  client_idempotency_key
)
values (
  '30000000-0000-0000-0000-000000000040',
  '30000000-0000-0000-0000-000000000030',
  'user',
  'Zhi Flow 如何帮助学习 RAG？',
  'completed',
  'seed-user-message'
);

insert into public.messages (
  id,
  conversation_id,
  role,
  content,
  status,
  source_message_id
)
values (
  '30000000-0000-0000-0000-000000000041',
  '30000000-0000-0000-0000-000000000030',
  'assistant',
  '它通过按里程碑推进来帮助学习 AI 聊天与 RAG。',
  'completed',
  '30000000-0000-0000-0000-000000000040'
);

insert into public.rag_runs (
  id,
  conversation_id,
  knowledge_base_id,
  user_message_id,
  assistant_message_id,
  standalone_question,
  config_snapshot,
  final_context_chunk_ids,
  result
)
values (
  '30000000-0000-0000-0000-000000000050',
  '30000000-0000-0000-0000-000000000030',
  '30000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000040',
  '30000000-0000-0000-0000-000000000041',
  'Zhi Flow 如何帮助学习 RAG？',
  '{"embeddingModel":"BAAI/bge-m3","source":"seed-without-real-model"}',
  array['30000000-0000-0000-0000-000000000020']::uuid[],
  '{"status":"seeded"}'
);

insert into public.citations (
  id,
  rag_run_id,
  assistant_message_id,
  chunk_id,
  document_id,
  display_order,
  document_name,
  page_start,
  page_end,
  heading_path,
  quote,
  source_locator
)
values (
  '30000000-0000-0000-0000-000000000060',
  '30000000-0000-0000-0000-000000000050',
  '30000000-0000-0000-0000-000000000041',
  '30000000-0000-0000-0000-000000000020',
  '30000000-0000-0000-0000-000000000010',
  1,
  'zhi-flow-introduction.md',
  1,
  1,
  array['Zhi Flow 简介'],
  '按里程碑推进的方式学习 AI 聊天与 RAG',
  'zhi-flow-introduction.md#zhi-flow-简介'
);
