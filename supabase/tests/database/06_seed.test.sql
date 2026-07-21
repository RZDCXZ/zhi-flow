begin;

select plan(3);

select is(
  (
    select name
    from public.knowledge_bases
    where id = '30000000-0000-0000-0000-000000000001'
  ),
  'Zhi Flow 入门知识库',
  'minimal seed creates the learning Knowledge Base'
);

select is(
  (
    select count(*)::integer
    from public.knowledge_bases kb
    join public.documents d on d.knowledge_base_id = kb.id
    join public.document_chunks dc on dc.document_id = d.id
    join public.conversations c on c.knowledge_base_id = kb.id
    join public.messages um on um.conversation_id = c.id and um.role = 'user'
    join public.messages am on am.source_message_id = um.id and am.role = 'assistant'
    join public.rag_runs rr on rr.assistant_message_id = am.id
    join public.citations ci on ci.rag_run_id = rr.id and ci.chunk_id = dc.id
    where kb.id = '30000000-0000-0000-0000-000000000001'
  ),
  1,
  'minimal seed connects every foundational relation'
);

select is(
  (
    select extensions.vector_dims(embedding)
    from public.document_chunks
    where id = '30000000-0000-0000-0000-000000000020'
  ),
  1024,
  'seed embedding uses the required 1024 dimensions'
);

select * from finish();
rollback;
