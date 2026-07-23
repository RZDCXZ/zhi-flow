begin;

select plan(5);

select has_table(
  'public',
  'storage_cleanup_jobs',
  'storage cleanup jobs table exists'
);

select throws_ok(
  $$
    insert into public.storage_cleanup_jobs (
      knowledge_base_id,
      storage_prefix
    )
    values (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ''
    )
  $$,
  '23514',
  null,
  'storage cleanup job requires a Storage prefix'
);

set local role anon;

select is(
  has_table_privilege('anon', 'public.storage_cleanup_jobs', 'select'),
  false,
  'anon cannot read storage cleanup jobs'
);

select throws_ok(
  $$
    insert into public.storage_cleanup_jobs (
      knowledge_base_id,
      storage_prefix
    )
    values (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
  $$,
  '42501',
  null,
  'anon cannot create storage cleanup jobs'
);

reset role;

select lives_ok(
  $$
    insert into public.storage_cleanup_jobs (
      knowledge_base_id,
      storage_prefix
    )
    values (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
  $$,
  'database owner can create a tracked cleanup job'
);

select * from finish();

rollback;
