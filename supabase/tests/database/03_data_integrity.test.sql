begin;

select plan(5);

insert into public.knowledge_bases (id, name)
values ('10000000-0000-0000-0000-000000000001', '完整性测试');

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
  '10000000-0000-0000-0000-000000000010',
  '10000000-0000-0000-0000-000000000001',
  'integrity.md',
  'integrity/integrity.md',
  'text/markdown',
  256,
  2,
  repeat('c', 64),
  'ready',
  'completed'
);

insert into public.conversations (id, title, mode)
values (
  '10000000-0000-0000-0000-000000000030',
  '完整性会话',
  'general'
);

insert into public.messages (
  conversation_id,
  role,
  content,
  status,
  client_idempotency_key
)
values (
  '10000000-0000-0000-0000-000000000030',
  'user',
  '第一次提交',
  'completed',
  'same-client-key'
);

select throws_ok(
  $$insert into public.knowledge_bases (name) values ('   ')$$,
  '23514',
  null,
  'Knowledge Base rejects a blank name'
);

select throws_ok(
  $$insert into public.documents (
      knowledge_base_id, original_filename, storage_object_key, mime_type,
      byte_size, sha256, status, current_stage
    ) values (
      '10000000-0000-0000-0000-000000000001', 'empty.md',
      'integrity/empty.md', 'text/markdown', 0, repeat('d', 64),
      'uploaded', 'stored'
    )$$,
  '23514',
  null,
  'Document rejects an empty file size'
);

select throws_ok(
  $$insert into public.documents (
      knowledge_base_id, original_filename, storage_object_key, mime_type,
      byte_size, sha256, status, current_stage
    ) values (
      '10000000-0000-0000-0000-000000000001', 'bad-hash.md',
      'integrity/bad-hash.md', 'text/markdown', 1, 'not-a-sha256',
      'uploaded', 'stored'
    )$$,
  '23514',
  null,
  'Document rejects an invalid SHA-256 digest'
);

select throws_ok(
  $$insert into public.document_chunks (
      document_id, knowledge_base_id, document_version, chunking_version,
      chunk_index, content, estimated_token_count, page_start, page_end,
      source_locator, embedding_model, embedding
    ) values (
      '10000000-0000-0000-0000-000000000010',
      '10000000-0000-0000-0000-000000000001',
      1, 'structure-v1', 0, '页码范围错误', 5, 2, 1,
      'integrity.md#bad-page-range', 'BAAI/bge-m3',
      array_fill(0::real, array[1024])::extensions.vector
    )$$,
  '23514',
  null,
  'Document Chunk rejects a reversed page range'
);

select throws_ok(
  $$insert into public.messages (
      conversation_id, role, content, status, client_idempotency_key
    ) values (
      '10000000-0000-0000-0000-000000000030', 'user', '重复提交',
      'completed', 'same-client-key'
    )$$,
  '23505',
  null,
  'Conversation rejects a duplicate client idempotency key'
);

select * from finish();
rollback;
