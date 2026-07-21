begin;

select plan(8);

select ok(
  exists(select 1 from storage.buckets where id = 'documents'),
  'private Document Storage bucket exists'
);

select is(
  (select public from storage.buckets where id = 'documents'),
  false,
  'Document Storage bucket is private'
);

select is(
  (select file_size_limit from storage.buckets where id = 'documents'),
  20::bigint * 1024 * 1024,
  'Document Storage bucket enforces the 20 MiB limit'
);

select is(
  (
    select count(*)::integer
    from pg_class
    where oid in (
      'public.knowledge_bases'::regclass,
      'public.documents'::regclass,
      'public.document_chunks'::regclass,
      'public.conversations'::regclass,
      'public.messages'::regclass,
      'public.rag_runs'::regclass,
      'public.citations'::regclass
    )
      and relrowsecurity
  ),
  7,
  'all application tables enable row-level security'
);

select is(
  has_table_privilege('anon', 'public.knowledge_bases', 'select'),
  false,
  'anonymous clients cannot read application tables'
);

select is(
  has_table_privilege('authenticated', 'public.knowledge_bases', 'select'),
  false,
  'authenticated clients cannot bypass the service boundary'
);

select is(
  has_table_privilege('service_role', 'public.knowledge_bases', 'select'),
  true,
  'the server service role can access application tables'
);

select is(
  has_function_privilege(
    'anon',
    'public.enforce_citation_integrity()',
    'execute'
  ),
  false,
  'anonymous clients cannot invoke internal consistency functions'
);

select * from finish();
rollback;
