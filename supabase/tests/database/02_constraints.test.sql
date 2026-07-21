begin;

select plan(11);

insert into public.knowledge_bases (id, name)
values
  ('00000000-0000-0000-0000-000000000001', '测试知识库'),
  ('00000000-0000-0000-0000-000000000002', '另一个知识库');

insert into public.documents (
  id,
  knowledge_base_id,
  original_filename,
  storage_object_key,
  mime_type,
  byte_size,
  sha256,
  status,
  current_stage
)
values
  (
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000001',
    'database.md',
    'test/database.md',
    'text/markdown',
    128,
    repeat('a', 64),
    'ready',
    'completed'
  ),
  (
    '00000000-0000-0000-0000-000000000011',
    '00000000-0000-0000-0000-000000000002',
    'other.md',
    'test/other.md',
    'text/markdown',
    64,
    repeat('b', 64),
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
  source_locator,
  embedding_model,
  embedding
)
values
  (
    '00000000-0000-0000-0000-000000000020',
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000001',
    1,
    'structure-v1',
    0,
    '关系模型通过外键保持关联数据一致。',
    16,
    'database.md#关系模型',
    'BAAI/bge-m3',
    array_fill(0::real, array[1024])::extensions.vector
  ),
  (
    '00000000-0000-0000-0000-000000000021',
    '00000000-0000-0000-0000-000000000011',
    '00000000-0000-0000-0000-000000000002',
    1,
    'structure-v1',
    0,
    '这是另一个 Knowledge Base 的原文。',
    12,
    'other.md#other',
    'BAAI/bge-m3',
    array_fill(0::real, array[1024])::extensions.vector
  );

insert into public.conversations (id, title, mode, knowledge_base_id)
values (
  '00000000-0000-0000-0000-000000000030',
  '数据库学习',
  'knowledge_base',
  '00000000-0000-0000-0000-000000000001'
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
  '00000000-0000-0000-0000-000000000040',
  '00000000-0000-0000-0000-000000000030',
  'user',
  '什么是关系模型？',
  'completed',
  'test-user-message'
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
  '00000000-0000-0000-0000-000000000041',
  '00000000-0000-0000-0000-000000000030',
  'assistant',
  '关系模型使用表、键和约束组织数据。',
  'completed',
  '00000000-0000-0000-0000-000000000040'
);

insert into public.rag_runs (
  id,
  conversation_id,
  knowledge_base_id,
  user_message_id,
  assistant_message_id,
  standalone_question
)
values (
  '00000000-0000-0000-0000-000000000050',
  '00000000-0000-0000-0000-000000000030',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000040',
  '00000000-0000-0000-0000-000000000041',
  '什么是关系模型？'
);

select throws_ok(
  $$insert into public.documents (
      knowledge_base_id, original_filename, storage_object_key, mime_type,
      byte_size, sha256, status
    ) values (
      '00000000-0000-0000-0000-000000000001', 'bad.md', 'test/bad.md',
      'text/markdown', 1, repeat('b', 64), 'unknown'
    )$$,
  '22P02',
  null,
  'Document rejects an invalid status'
);

select throws_ok(
  $$insert into public.conversations (title, mode, knowledge_base_id)
    values ('错误通用会话', 'general', '00000000-0000-0000-0000-000000000001')$$,
  '23514',
  null,
  'general Conversation rejects a Knowledge Base binding'
);

select throws_ok(
  $$insert into public.conversations (title, mode)
    values ('缺少知识库', 'knowledge_base')$$,
  '23514',
  null,
  'knowledge-base Conversation requires a Knowledge Base binding'
);

select throws_ok(
  $$insert into public.messages (
      conversation_id, role, content, status, client_idempotency_key
    ) values (
      '00000000-0000-0000-0000-000000000030', 'user', '错误状态',
      'streaming', 'bad-user-status'
    )$$,
  '23514',
  null,
  'user Message rejects a non-completed status'
);

select throws_ok(
  $$insert into public.messages (
      conversation_id, role, content, status, source_message_id
    ) values (
      '00000000-0000-0000-0000-000000000030', 'assistant', '错误来源',
      'completed', '00000000-0000-0000-0000-000000000041'
    )$$,
  '23514',
  null,
  'assistant Message requires a user Message source'
);

select throws_ok(
  $$insert into public.rag_runs (
      conversation_id, knowledge_base_id, user_message_id, assistant_message_id
    ) values (
      '00000000-0000-0000-0000-000000000030',
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000041',
      '00000000-0000-0000-0000-000000000040'
    )$$,
  '23514',
  null,
  'RAG Run rejects swapped user and assistant Messages'
);

select throws_ok(
  $$update public.rag_runs
    set knowledge_base_id = '00000000-0000-0000-0000-000000000002'
    where id = '00000000-0000-0000-0000-000000000050'$$,
  '23514',
  null,
  'RAG Run rejects the wrong Knowledge Base'
);

select throws_ok(
  $$insert into public.citations (
      rag_run_id, assistant_message_id, chunk_id, document_id, display_order,
      document_name, quote, source_locator
    ) values (
      '00000000-0000-0000-0000-000000000050',
      '00000000-0000-0000-0000-000000000041',
      '00000000-0000-0000-0000-000000000020',
      '00000000-0000-0000-0000-000000000010',
      1, 'database.md', '这段摘录不在原文中', 'database.md#关系模型'
    )$$,
  '23514',
  null,
  'Citation rejects a quote that cannot be traced to its Chunk'
);

select throws_ok(
  $$insert into public.citations (
      rag_run_id, assistant_message_id, chunk_id, document_id, display_order,
      document_name, quote, source_locator
    ) values (
      '00000000-0000-0000-0000-000000000050',
      '00000000-0000-0000-0000-000000000041',
      '00000000-0000-0000-0000-000000000021',
      '00000000-0000-0000-0000-000000000011',
      1, 'other.md', '另一个 Knowledge Base 的原文', 'other.md#other'
    )$$,
  '23514',
  null,
  'Citation rejects a Document Chunk from another Knowledge Base'
);

select throws_ok(
  $$insert into public.document_chunks (
      document_id, knowledge_base_id, document_version, chunking_version,
      chunk_index, content, estimated_token_count, source_locator,
      embedding_model, embedding
    ) values (
      '00000000-0000-0000-0000-000000000010',
      '00000000-0000-0000-0000-000000000002',
      1, 'structure-v1', 1, '错误关联', 4, 'bad', 'BAAI/bge-m3',
      array_fill(0::real, array[1024])::extensions.vector
    )$$,
  '23503',
  null,
  'Document Chunk rejects a mismatched Knowledge Base'
);

select throws_ok(
  $$insert into public.document_chunks (
      document_id, knowledge_base_id, document_version, chunking_version,
      chunk_index, content, estimated_token_count, source_locator,
      embedding_model, embedding
    ) values (
      '00000000-0000-0000-0000-000000000010',
      '00000000-0000-0000-0000-000000000001',
      1, 'structure-v1', 1, '错误维度', 4, 'bad-dimension', 'BAAI/bge-m3',
      array_fill(0::real, array[3])::extensions.vector
    )$$,
  '22000',
  null,
  'Document Chunk rejects a non-1024-dimensional embedding'
);

select * from finish();
rollback;
