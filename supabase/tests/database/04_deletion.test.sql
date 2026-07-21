begin;

select plan(10);

insert into public.knowledge_bases (id, name)
values
  ('20000000-0000-0000-0000-000000000001', '删除语义测试'),
  ('20000000-0000-0000-0000-000000000002', '级联知识库');

insert into public.documents (
  id, knowledge_base_id, original_filename, storage_object_key, mime_type,
  byte_size, sha256, status, current_stage
)
values
  (
    '20000000-0000-0000-0000-000000000010',
    '20000000-0000-0000-0000-000000000001',
    'delete.md', 'delete/delete.md', 'text/markdown', 64, repeat('e', 64),
    'ready', 'completed'
  ),
  (
    '20000000-0000-0000-0000-000000000011',
    '20000000-0000-0000-0000-000000000002',
    'cascade.md', 'delete/cascade.md', 'text/markdown', 64, repeat('f', 64),
    'ready', 'completed'
  );

insert into public.document_chunks (
  id, document_id, knowledge_base_id, document_version, chunking_version,
  chunk_index, content, estimated_token_count, source_locator,
  embedding_model, embedding
)
values
  (
    '20000000-0000-0000-0000-000000000020',
    '20000000-0000-0000-0000-000000000010',
    '20000000-0000-0000-0000-000000000001',
    1, 'structure-v1', 0, '删除 Document 会删除它的 Chunk。', 10,
    'delete.md#cascade', 'BAAI/bge-m3',
    array_fill(0::real, array[1024])::extensions.vector
  ),
  (
    '20000000-0000-0000-0000-000000000021',
    '20000000-0000-0000-0000-000000000011',
    '20000000-0000-0000-0000-000000000002',
    1, 'structure-v1', 0, '删除 Knowledge Base 会删除它的 Document Chunk。', 12,
    'cascade.md#cascade', 'BAAI/bge-m3',
    array_fill(0::real, array[1024])::extensions.vector
  );

insert into public.conversations (id, title, mode, knowledge_base_id)
values (
  '20000000-0000-0000-0000-000000000030',
  '删除语义会话', 'knowledge_base',
  '20000000-0000-0000-0000-000000000001'
);

insert into public.messages (
  id, conversation_id, role, content, status, client_idempotency_key
)
values (
  '20000000-0000-0000-0000-000000000040',
  '20000000-0000-0000-0000-000000000030',
  'user', '删除语义是什么？', 'completed', 'delete-user-message'
);

insert into public.messages (
  id, conversation_id, role, content, status, source_message_id
)
values (
  '20000000-0000-0000-0000-000000000041',
  '20000000-0000-0000-0000-000000000030',
  'assistant', '外键定义了删除语义。', 'completed',
  '20000000-0000-0000-0000-000000000040'
);

insert into public.rag_runs (
  id, conversation_id, knowledge_base_id, user_message_id,
  assistant_message_id, standalone_question
)
values (
  '20000000-0000-0000-0000-000000000050',
  '20000000-0000-0000-0000-000000000030',
  '20000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000040',
  '20000000-0000-0000-0000-000000000041',
  '删除语义是什么？'
);

insert into public.citations (
  rag_run_id, assistant_message_id, chunk_id, document_id, display_order,
  document_name, quote, source_locator
)
values (
  '20000000-0000-0000-0000-000000000050',
  '20000000-0000-0000-0000-000000000041',
  '20000000-0000-0000-0000-000000000020',
  '20000000-0000-0000-0000-000000000010',
  1, 'delete.md', '删除 Document 会删除它的 Chunk。', 'delete.md#cascade'
);

insert into public.conversations (id, title, mode, knowledge_base_id)
values (
  '20000000-0000-0000-0000-000000000031',
  '知识库级联会话', 'knowledge_base',
  '20000000-0000-0000-0000-000000000002'
);

insert into public.messages (
  id, conversation_id, role, content, status, client_idempotency_key
)
values (
  '20000000-0000-0000-0000-000000000042',
  '20000000-0000-0000-0000-000000000031',
  'user', '删除知识库会怎样？', 'completed', 'delete-knowledge-base'
);

insert into public.messages (
  id, conversation_id, role, content, status, source_message_id
)
values (
  '20000000-0000-0000-0000-000000000043',
  '20000000-0000-0000-0000-000000000031',
  'assistant', '关联数据会级联删除。', 'completed',
  '20000000-0000-0000-0000-000000000042'
);

insert into public.rag_runs (
  id, conversation_id, knowledge_base_id, user_message_id,
  assistant_message_id, standalone_question
)
values (
  '20000000-0000-0000-0000-000000000051',
  '20000000-0000-0000-0000-000000000031',
  '20000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000042',
  '20000000-0000-0000-0000-000000000043',
  '删除知识库会怎样？'
);

insert into public.citations (
  id, rag_run_id, assistant_message_id, chunk_id, document_id, display_order,
  document_name, quote, source_locator
)
values (
  '20000000-0000-0000-0000-000000000061',
  '20000000-0000-0000-0000-000000000051',
  '20000000-0000-0000-0000-000000000043',
  '20000000-0000-0000-0000-000000000021',
  '20000000-0000-0000-0000-000000000011',
  1, 'cascade.md', '删除 Knowledge Base 会删除它的 Document Chunk。',
  'cascade.md#cascade'
);

select lives_ok(
  $$delete from public.documents
    where id = '20000000-0000-0000-0000-000000000010'$$,
  'Document can be deleted'
);
select is(
  (select count(*)::integer from public.document_chunks where document_id = '20000000-0000-0000-0000-000000000010'),
  0,
  'deleting a Document cascades to its Document Chunks'
);
select is(
  (select count(*)::integer from public.citations where document_id = '20000000-0000-0000-0000-000000000010'),
  0,
  'deleting a Document removes Citations through its Document Chunks'
);
select is(
  (select count(*)::integer from public.rag_runs where id = '20000000-0000-0000-0000-000000000050'),
  1,
  'deleting source content preserves the RAG Run trace'
);

update public.conversations
set summary_through_message_id = '20000000-0000-0000-0000-000000000040'
where id = '20000000-0000-0000-0000-000000000030';

select lives_ok(
  $$delete from public.messages
    where id = '20000000-0000-0000-0000-000000000040'$$,
  'a summarized Message can be deleted'
);
select is(
  (select summary_through_message_id from public.conversations where id = '20000000-0000-0000-0000-000000000030'),
  null,
  'deleting the summarized Message clears the Conversation summary pointer'
);
select is(
  (select count(*)::integer from public.messages where id = '20000000-0000-0000-0000-000000000041'),
  0,
  'deleting a user Message cascades to its assistant attempts'
);
select is(
  (select count(*)::integer from public.rag_runs where id = '20000000-0000-0000-0000-000000000050'),
  0,
  'deleting the Message pair cascades to its RAG Run'
);

select lives_ok(
  $$delete from public.knowledge_bases
    where id = '20000000-0000-0000-0000-000000000002'$$,
  'a bound Knowledge Base can be deleted after confirmation'
);
select is(
  (
    select count(*)::integer
    from public.documents
    where knowledge_base_id = '20000000-0000-0000-0000-000000000002'
  ) + (
    select count(*)::integer
    from public.document_chunks
    where knowledge_base_id = '20000000-0000-0000-0000-000000000002'
  ) + (
    select count(*)::integer
    from public.conversations
    where knowledge_base_id = '20000000-0000-0000-0000-000000000002'
  ) + (
    select count(*)::integer
    from public.messages
    where conversation_id = '20000000-0000-0000-0000-000000000031'
  ) + (
    select count(*)::integer
    from public.rag_runs
    where knowledge_base_id = '20000000-0000-0000-0000-000000000002'
  ) + (
    select count(*)::integer
    from public.citations
    where id = '20000000-0000-0000-0000-000000000061'
  ),
  0,
  'deleting a Knowledge Base cascades through all bound foundational data'
);

select * from finish();
rollback;
