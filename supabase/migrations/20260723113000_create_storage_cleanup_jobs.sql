create table public.storage_cleanup_jobs (
  id uuid primary key default gen_random_uuid(),
  knowledge_base_id uuid not null,
  bucket text not null default 'documents',
  object_keys text[] not null,
  created_at timestamptz not null default now(),
  constraint storage_cleanup_jobs_bucket_check
    check (nullif(btrim(bucket), '') is not null),
  constraint storage_cleanup_jobs_object_keys_check
    check (cardinality(object_keys) > 0)
);

create index storage_cleanup_jobs_created_at_idx
on public.storage_cleanup_jobs (created_at);

alter table public.storage_cleanup_jobs enable row level security;

revoke all privileges on table public.storage_cleanup_jobs
from anon, authenticated;

grant select, insert, update, delete on table public.storage_cleanup_jobs
to service_role;
